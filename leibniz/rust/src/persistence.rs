//! Versioned, deterministic, offline graph persistence using only Rust std.
//!
//! The checksum detects accidental corruption; it is NOT a signature,
//! encryption, tamper protection, or a zero-knowledge proof. Only write to
//! private storage. Saving never calls GAUSS or the public NEXUS repository.

use crate::schema::{AttributeValue, Entity, Flow, Restriction, RestrictionType};
use crate::{
    ArgumentKind, Atom, Fact, Graph, GraphArchive, Justification, Pattern, PatternTerm, Predicate,
    Rule, Term,
};
use std::collections::{BTreeSet, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const MAGIC: &[u8; 8] = b"LEIBNIZ\0";
const VERSION: u32 = 1;
const MAX_ARCHIVE: usize = 64 * 1024 * 1024;
const MAX_STRING: usize = 1024 * 1024;
const MAX_ITEMS: usize = 1_000_000;
const HEADER_LENGTH: usize = 8 + 4 + 8;
const FOOTER_LENGTH: usize = 8;

fn checksum(data: &[u8]) -> u64 {
    // FNV-1a is an integrity check against accidental damage, NOT cryptography.
    data.iter().fold(0xcbf29ce484222325_u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    })
}

// A hostile or unexpectedly large graph must not be fully serialized in memory
// before the archive limit is checked. Every append is checked first.
struct Writer(Vec<u8>, bool, usize);
impl Default for Writer {
    fn default() -> Self {
        Self(Vec::new(), false, MAX_ARCHIVE)
    }
}

impl Writer {
    fn append(&mut self, bytes: &[u8]) {
        if self.1 {
            return;
        }
        if !matches!(self.0.len().checked_add(bytes.len()), Some(n) if n <= self.2) {
            self.1 = true;
            return;
        }
        self.0.extend_from_slice(bytes);
    }
    fn byte(&mut self, v: u8) {
        self.append(&[v]);
    }
    fn u32(&mut self, v: u32) {
        self.append(&v.to_le_bytes());
    }
    fn u64(&mut self, v: u64) {
        self.append(&v.to_le_bytes());
    }
    fn string(&mut self, s: &str) -> Result<(), String> {
        if s.len() > MAX_STRING {
            return Err("archive string exceeds size limit".into());
        }
        let len = u32::try_from(s.len()).map_err(|_| "string length overflow")?;
        // Reject before appending either the length prefix or the string.
        if self.1
            || !matches!(self.0.len().checked_add(4).and_then(|n| n.checked_add(s.len())),
            Some(n) if n <= self.2)
        {
            return Err("archive payload exceeds size limit".into());
        }
        self.u32(len);
        self.append(s.as_bytes());
        Ok(())
    }
    fn count(&mut self, n: usize) -> Result<(), String> {
        if n > MAX_ITEMS {
            return Err("archive collection exceeds size limit".into());
        }
        if self.1 || !matches!(self.0.len().checked_add(4), Some(n) if n <= self.2) {
            return Err("archive payload exceeds size limit".into());
        }
        self.u32(u32::try_from(n).map_err(|_| "collection length overflow")?);
        Ok(())
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    cursor: usize,
}
impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, cursor: 0 }
    }
    fn take(&mut self, size: usize) -> Result<&'a [u8], String> {
        let end = self
            .cursor
            .checked_add(size)
            .ok_or("archive offset overflow")?;
        let part = self
            .bytes
            .get(self.cursor..end)
            .ok_or("truncated archive")?;
        self.cursor = end;
        Ok(part)
    }
    fn byte(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Result<u32, String> {
        let mut raw = [0; 4];
        raw.copy_from_slice(self.take(4)?);
        Ok(u32::from_le_bytes(raw))
    }
    fn u64(&mut self) -> Result<u64, String> {
        let mut raw = [0; 8];
        raw.copy_from_slice(self.take(8)?);
        Ok(u64::from_le_bytes(raw))
    }
    fn string(&mut self) -> Result<String, String> {
        let size = self.u32()? as usize;
        if size > MAX_STRING {
            return Err("archive string exceeds size limit".into());
        }
        String::from_utf8(self.take(size)?.to_vec()).map_err(|_| "invalid UTF-8 in archive".into())
    }
    fn count(&mut self) -> Result<usize, String> {
        let size = self.u32()? as usize;
        if size > MAX_ITEMS {
            return Err("archive collection exceeds size limit".into());
        }
        Ok(size)
    }
    fn finished(&self) -> bool {
        self.cursor == self.bytes.len()
    }
}

fn encode_kind(w: &mut Writer, kind: &ArgumentKind) -> Result<(), String> {
    match kind {
        ArgumentKind::AnyEntity => w.byte(0),
        ArgumentKind::EntityCategory(category) => {
            w.byte(1);
            w.string(category)?;
        }
        ArgumentKind::Statement => w.byte(2),
    }
    Ok(())
}
fn decode_kind(r: &mut Reader<'_>) -> Result<ArgumentKind, String> {
    match r.byte()? {
        0 => Ok(ArgumentKind::AnyEntity),
        1 => Ok(ArgumentKind::EntityCategory(r.string()?)),
        2 => Ok(ArgumentKind::Statement),
        _ => Err("invalid argument type tag".into()),
    }
}
fn encode_term(w: &mut Writer, term: &Term) -> Result<(), String> {
    match term {
        Term::Entity(id) => {
            w.byte(0);
            w.string(id)?;
        }
        Term::Statement(id) => {
            w.byte(1);
            w.u64(*id);
        }
    }
    Ok(())
}
fn decode_term(r: &mut Reader<'_>) -> Result<Term, String> {
    match r.byte()? {
        0 => Ok(Term::Entity(r.string()?)),
        1 => Ok(Term::Statement(r.u64()?)),
        _ => Err("invalid term type tag".into()),
    }
}
fn encode_pattern(w: &mut Writer, pattern: &Pattern) -> Result<(), String> {
    w.string(&pattern.predicate)?;
    w.count(pattern.terms.len())?;
    for term in &pattern.terms {
        match term {
            PatternTerm::Variable(name) => {
                w.byte(0);
                w.string(name)?;
            }
            PatternTerm::Constant(value) => {
                w.byte(1);
                encode_term(w, value)?;
            }
        }
    }
    Ok(())
}
fn decode_pattern(r: &mut Reader<'_>) -> Result<Pattern, String> {
    let predicate = r.string()?;
    let n = r.count()?;
    let mut terms = Vec::new();
    for _ in 0..n {
        terms.push(match r.byte()? {
            0 => PatternTerm::Variable(r.string()?),
            1 => PatternTerm::Constant(decode_term(r)?),
            _ => return Err("invalid pattern tag".into()),
        });
    }
    Ok(Pattern { predicate, terms })
}
fn encode_atom(w: &mut Writer, atom: &Atom) -> Result<(), String> {
    w.string(&atom.predicate)?;
    w.count(atom.terms.len())?;
    for term in &atom.terms {
        encode_term(w, term)?;
    }
    Ok(())
}
fn decode_atom(r: &mut Reader<'_>) -> Result<Atom, String> {
    let predicate = r.string()?;
    let count = r.count()?;
    let mut terms = Vec::new();
    for _ in 0..count {
        terms.push(decode_term(r)?);
    }
    Ok(Atom { predicate, terms })
}

/// Deterministic bytes representing the entire assertion graph, including
/// predicate schemas, facts, provenance, rules, and contradiction declarations.
/// Loading replays and validates each entry through Graph's normal methods.
impl Graph {
    pub fn to_archive_bytes(&self) -> Result<Vec<u8>, String> {
        let snapshot = self.export_archive();
        let mut w = Writer::default();
        w.count(snapshot.entities.len())?;
        for entity in &snapshot.entities {
            w.string(&entity.id)?;
            w.string(&entity.category)?;
            w.count(entity.attributes.len())?;
            let mut attributes: Vec<_> = entity.attributes.iter().collect();
            attributes.sort_by(|a, b| a.0.cmp(b.0));
            for (name, val) in attributes {
                w.string(name)?;
                match val {
                    AttributeValue::Text(value) => {
                        w.byte(0);
                        w.string(value)?;
                    }
                    AttributeValue::Number(value) => {
                        w.byte(1);
                        w.u64(value.to_bits());
                    }
                    AttributeValue::Boolean(value) => {
                        w.byte(2);
                        w.byte(u8::from(*value));
                    }
                }
            }
        }
        w.count(snapshot.restrictions.len())?;
        for item in &snapshot.restrictions {
            w.string(&item.source_id)?;
            w.string(&item.target_id)?;
            w.byte(match item.constraint_type {
                RestrictionType::Immutable => 0,
                RestrictionType::Conditional => 1,
                RestrictionType::Elastic => 2,
            });
            w.u64(item.boundary_value.to_bits());
        }
        w.count(snapshot.flows.len())?;
        for item in &snapshot.flows {
            w.string(&item.from_entity)?;
            w.string(&item.to_entity)?;
            w.u64(item.rate_of_transfer.to_bits());
        }
        w.count(snapshot.predicates.len())?;
        for predicate in &snapshot.predicates {
            w.string(&predicate.name)?;
            w.count(predicate.arguments.len())?;
            for kind in &predicate.arguments {
                encode_kind(&mut w, kind)?;
            }
        }
        w.count(snapshot.assertions.len())?;
        for fact in &snapshot.assertions {
            let Justification::Asserted { source_id } = &fact.justification else {
                return Err("cannot persist derived facts as assertions".into());
            };
            w.u64(fact.id);
            encode_atom(&mut w, &fact.atom)?;
            w.string(source_id)?;
            w.count(fact.asserted_sources.len())?;
            for source in &fact.asserted_sources {
                w.string(source)?;
            }
        }
        w.count(snapshot.rules.len())?;
        for rule in &snapshot.rules {
            w.string(&rule.id)?;
            w.count(rule.body.len())?;
            for pattern in &rule.body {
                encode_pattern(&mut w, pattern)?;
            }
            encode_pattern(&mut w, &rule.head)?;
        }
        w.count(snapshot.incompatible.len())?;
        for (left, right) in &snapshot.incompatible {
            w.string(left)?;
            w.string(right)?;
        }
        if w.1 {
            return Err("archive payload exceeds size limit".into());
        }
        let mut output = Vec::with_capacity(HEADER_LENGTH + w.0.len() + FOOTER_LENGTH);
        output.extend_from_slice(MAGIC);
        output.extend_from_slice(&VERSION.to_le_bytes());
        output.extend_from_slice(&(w.0.len() as u64).to_le_bytes());
        output.extend_from_slice(&w.0);
        let integrity = checksum(&output);
        output.extend_from_slice(&integrity.to_le_bytes());
        Ok(output)
    }

    pub fn from_archive_bytes(data: &[u8]) -> Result<Self, String> {
        if data.len() < HEADER_LENGTH + FOOTER_LENGTH
            || data.len() > MAX_ARCHIVE + HEADER_LENGTH + FOOTER_LENGTH
        {
            return Err("invalid archive size".into());
        }
        if &data[..8] != MAGIC {
            return Err("invalid archive magic".into());
        }
        let mut header = Reader::new(&data[8..HEADER_LENGTH]);
        if header.u32()? != VERSION {
            return Err("unsupported archive version".into());
        }
        let declared = usize::try_from(header.u64()?).map_err(|_| "archive size overflow")?;
        if declared > MAX_ARCHIVE
            || declared.checked_add(HEADER_LENGTH + FOOTER_LENGTH) != Some(data.len())
        {
            return Err("archive length mismatch".into());
        }
        let checksum_offset = HEADER_LENGTH + declared;
        let mut footer = Reader::new(&data[checksum_offset..]);
        if footer.u64()? != checksum(&data[..checksum_offset]) {
            return Err("archive checksum mismatch".into());
        }
        let mut r = Reader::new(&data[HEADER_LENGTH..checksum_offset]);
        let count = r.count()?;
        let mut entities = Vec::new();
        for _ in 0..count {
            let id = r.string()?;
            let category = r.string()?;
            let n = r.count()?;
            let mut attributes = HashMap::new();
            for _ in 0..n {
                let key = r.string()?;
                let value = match r.byte()? {
                    0 => AttributeValue::Text(r.string()?),
                    1 => AttributeValue::Number(f64::from_bits(r.u64()?)),
                    2 => match r.byte()? {
                        0 => AttributeValue::Boolean(false),
                        1 => AttributeValue::Boolean(true),
                        _ => return Err("invalid boolean tag".into()),
                    },
                    _ => return Err("invalid attribute tag".into()),
                };
                if attributes.insert(key, value).is_some() {
                    return Err("duplicate archive attribute".into());
                }
            }
            entities.push(Entity {
                id,
                category,
                attributes,
            });
        }
        let count = r.count()?;
        let mut restrictions = Vec::new();
        for _ in 0..count {
            let source_id = r.string()?;
            let target_id = r.string()?;
            let constraint_type = match r.byte()? {
                0 => RestrictionType::Immutable,
                1 => RestrictionType::Conditional,
                2 => RestrictionType::Elastic,
                _ => return Err("invalid restriction tag".into()),
            };
            let boundary_value = f64::from_bits(r.u64()?);
            restrictions.push(Restriction {
                source_id,
                target_id,
                constraint_type,
                boundary_value,
            });
        }
        let count = r.count()?;
        let mut flows = Vec::new();
        for _ in 0..count {
            flows.push(Flow {
                from_entity: r.string()?,
                to_entity: r.string()?,
                rate_of_transfer: f64::from_bits(r.u64()?),
            });
        }
        let count = r.count()?;
        let mut predicates = Vec::new();
        for _ in 0..count {
            let name = r.string()?;
            let n = r.count()?;
            let mut arguments = Vec::new();
            for _ in 0..n {
                arguments.push(decode_kind(&mut r)?);
            }
            predicates.push(Predicate { name, arguments });
        }
        let count = r.count()?;
        let mut assertions = Vec::new();
        for _ in 0..count {
            let id = r.u64()?;
            let atom = decode_atom(&mut r)?;
            let source_id = r.string()?;
            let n = r.count()?;
            let mut asserted_sources = BTreeSet::new();
            for _ in 0..n {
                if !asserted_sources.insert(r.string()?) {
                    return Err("duplicate assertion source".into());
                }
            }
            assertions.push(Fact {
                id,
                atom,
                justification: Justification::Asserted { source_id },
                asserted_sources,
            });
        }
        let count = r.count()?;
        let mut rules = Vec::new();
        for _ in 0..count {
            let id = r.string()?;
            let n = r.count()?;
            let mut body = Vec::new();
            for _ in 0..n {
                body.push(decode_pattern(&mut r)?);
            }
            rules.push(Rule {
                id,
                body,
                head: decode_pattern(&mut r)?,
            });
        }
        let count = r.count()?;
        let mut incompatible = Vec::new();
        for _ in 0..count {
            incompatible.push((r.string()?, r.string()?));
        }
        if !r.finished() {
            return Err("trailing archive payload".into());
        }
        let graph = Graph::from_archive(GraphArchive {
            entities,
            restrictions,
            flows,
            predicates,
            assertions,
            rules,
            incompatible,
        })?;
        // Recovery must not silently normalize a checksummed but noncanonical
        // stream (for example an out-of-order attribute or source ledger).
        // This checks byte-for-byte representation, not authenticity: FNV-1a
        // is unkeyed and an attacker could replace the entire valid archive.
        if graph.to_archive_bytes()? != data {
            return Err("noncanonical archive encoding".into());
        }
        Ok(graph)
    }

    /// Write a completed file and sync it BEFORE atomic replacement. If any
    /// write fails, remove only our temporary file and leave the old archive.
    pub fn save_atomic(&self, path: &Path) -> Result<(), String> {
        let bytes = self.to_archive_bytes()?;
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let filename = path.file_name().ok_or("archive path must name a file")?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "system clock predates epoch")?
            .as_nanos();
        let temp = parent.join(format!(
            ".{}.{}.{}.leibniz-tmp",
            filename.to_string_lossy(),
            std::process::id(),
            stamp
        ));
        let outcome = (|| -> std::io::Result<()> {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            options.mode(0o600);
            let mut file = options.open(&temp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temp, path)?;
            // Directory sync makes the rename durable on Unix filesystems
            // where the containing directory supports fsync.
            #[cfg(unix)]
            File::open(parent)?.sync_all()?;
            Ok(())
        })();
        if outcome.is_err() {
            let _ = fs::remove_file(&temp);
        }
        outcome.map_err(|error| format!("failed to save archive: {error}"))
    }

    pub fn load(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|error| format!("cannot open archive: {error}"))?;
        let mut bytes = Vec::new();
        file.take((MAX_ARCHIVE + HEADER_LENGTH + FOOTER_LENGTH + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("cannot read archive: {error}"))?;
        Self::from_archive_bytes(&bytes)
    }
}

#[cfg(test)]
mod writer_budget_tests {
    use super::*;

    #[test]
    fn writer_rejects_large_string_before_allocating_or_writing_partial_prefix() {
        let mut writer = Writer(Vec::new(), false, 16);
        writer.0.resize(11, 0);
        let before = writer.0.len();
        assert!(writer.string("ab").unwrap_err().contains("payload exceeds"));
        assert_eq!(writer.0.len(), before);
        assert!(!writer.1);
    }

    #[test]
    fn fixed_width_values_cannot_grow_a_full_archive_and_fail_closed() {
        let mut writer = Writer(Vec::new(), false, 16);
        writer.0.resize(16, 0);
        writer.u64(42);
        assert!(writer.1);
        assert_eq!(writer.0.len(), 16);
        assert!(writer.count(0).is_err());
    }

    #[test]
    fn exact_limit_is_accepted_and_next_byte_is_rejected() {
        let mut writer = Writer(Vec::new(), false, 16);
        writer.0.resize(15, 0);
        writer.byte(7);
        assert!(!writer.1);
        assert_eq!(writer.0.len(), 16);
        writer.byte(8);
        assert!(writer.1);
        assert_eq!(writer.0.len(), 16);
    }
}
