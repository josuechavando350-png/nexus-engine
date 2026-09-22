//! Deterministic, local persistence for *both* LEIBNIZ's graph and the
//! evidence-backed semantic annotations attached to its numeric records.
//!
//! This is a new envelope format, not a rewrite of the existing graph v1
//! archive. It contains the complete v1 archive unmodified, followed by
//! annotations bound by their index in the exact v1 graph order. Loading
//! revalidates the graph, units, timestamps and annotation cardinality.
//!
//! The FNV checksum catches accidental damage only. It is NOT encryption,
//! authentication, a signature, a ZK proof or protection against forgery.

use crate::schema::AttributeValue;
use crate::semantics::{Annotation, Dimension, SemanticSnapshot, Unit, Validity};
use crate::Graph;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const MAGIC: &[u8; 8] = b"LEIBSEM\0";
const VERSION: u32 = 1;
const MAX_GRAPH_BYTES: usize = 64 * 1024 * 1024 + 28;
const MAX_METADATA_BYTES: usize = 16 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: usize = MAX_GRAPH_BYTES + MAX_METADATA_BYTES + 32;
const MAX_ANNOTATIONS: usize = 100_000;
const MAX_STRING: usize = 64 * 1024;
const MAX_DIMENSIONS: usize = 64;
const HEADER_LENGTH: usize = 8 + 4 + 8;
const FOOTER_LENGTH: usize = 8;

fn checksum(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325_u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    })
}

// Limit every append, including fixed-width annotation fields. A post-hoc
// payload length check would allow many annotations to exhaust memory first.
const MAX_PAYLOAD_BYTES: usize = MAX_GRAPH_BYTES + MAX_METADATA_BYTES;
struct Writer(Vec<u8>, bool, usize);
impl Default for Writer {
    fn default() -> Self {
        Self(Vec::new(), false, MAX_PAYLOAD_BYTES)
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
    fn u32(&mut self, number: u32) {
        self.append(&number.to_le_bytes());
    }
    fn u64(&mut self, number: u64) {
        self.append(&number.to_le_bytes());
    }
    fn i64(&mut self, number: i64) {
        self.append(&number.to_le_bytes());
    }
    fn i16(&mut self, number: i16) {
        self.append(&number.to_le_bytes());
    }
    fn byte(&mut self, number: u8) {
        self.append(&[number]);
    }
    fn bytes(&mut self, bytes: &[u8]) -> Result<(), String> {
        let len = u32::try_from(bytes.len()).map_err(|_| "archive byte length overflow")?;
        if self.1
            || !matches!(self.0.len().checked_add(4).and_then(|n| n.checked_add(bytes.len())),
            Some(n) if n <= self.2)
        {
            return Err("semantic archive payload exceeds size limit".into());
        }
        self.u32(len);
        self.append(bytes);
        Ok(())
    }
    fn string(&mut self, value: &str) -> Result<(), String> {
        if value.len() > MAX_STRING {
            return Err("semantic string exceeds limit".into());
        }
        self.bytes(value.as_bytes())
    }
    fn count(&mut self, count: usize) -> Result<(), String> {
        if count > MAX_ANNOTATIONS {
            return Err("too many semantic annotations".into());
        }
        if self.1 || !matches!(self.0.len().checked_add(4), Some(n) if n <= self.2) {
            return Err("semantic archive payload exceeds size limit".into());
        }
        self.u32(u32::try_from(count).map_err(|_| "annotation count overflow")?);
        Ok(())
    }
    fn annotation(&mut self, annotation: &Annotation) -> Result<(), String> {
        self.string(&annotation.unit.symbol)?;
        self.u64(annotation.unit.scale_to_reference.to_bits());
        let dimensions = annotation.unit.dimension.powers();
        if dimensions.len() > MAX_DIMENSIONS {
            return Err("too many base dimensions".into());
        }
        self.u32(u32::try_from(dimensions.len()).map_err(|_| "dimension count overflow")?);
        for (name, power) in dimensions {
            self.string(name)?;
            self.i16(*power);
        }
        self.i64(annotation.validity.start_ms);
        match annotation.validity.end_ms {
            Some(end) => {
                self.byte(1);
                self.i64(end);
            }
            None => self.byte(0),
        }
        self.string(&annotation.evidence_id)?;
        if self.1 {
            return Err("semantic archive payload exceeds size limit".into());
        }
        Ok(())
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }
    fn take(&mut self, len: usize) -> Result<&'a [u8], String> {
        let end = self
            .offset
            .checked_add(len)
            .ok_or("archive offset overflow")?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or("truncated semantic archive")?;
        self.offset = end;
        Ok(value)
    }
    fn byte(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Result<u32, String> {
        let mut bytes = [0_u8; 4];
        bytes.copy_from_slice(self.take(4)?);
        Ok(u32::from_le_bytes(bytes))
    }
    fn u64(&mut self) -> Result<u64, String> {
        let mut bytes = [0_u8; 8];
        bytes.copy_from_slice(self.take(8)?);
        Ok(u64::from_le_bytes(bytes))
    }
    fn i64(&mut self) -> Result<i64, String> {
        let mut bytes = [0_u8; 8];
        bytes.copy_from_slice(self.take(8)?);
        Ok(i64::from_le_bytes(bytes))
    }
    fn i16(&mut self) -> Result<i16, String> {
        let mut bytes = [0_u8; 2];
        bytes.copy_from_slice(self.take(2)?);
        Ok(i16::from_le_bytes(bytes))
    }
    fn blob(&mut self, max_len: usize) -> Result<&'a [u8], String> {
        let len = self.u32()? as usize;
        if len > max_len {
            return Err("semantic field exceeds size limit".into());
        }
        self.take(len)
    }
    fn string(&mut self) -> Result<String, String> {
        String::from_utf8(self.blob(MAX_STRING)?.to_vec())
            .map_err(|_| "invalid UTF-8 in semantic archive".into())
    }
    fn count(&mut self, max: usize) -> Result<usize, String> {
        let n = self.u32()? as usize;
        if n > max {
            return Err("semantic collection exceeds limit".into());
        }
        Ok(n)
    }
    fn annotation(&mut self) -> Result<Annotation, String> {
        let symbol = self.string()?;
        let scale = f64::from_bits(self.u64()?);
        let n = self.count(MAX_DIMENSIONS)?;
        let mut powers = Vec::new();
        for _ in 0..n {
            powers.push((self.string()?, self.i16()?));
        }
        let dimension = if powers.is_empty() {
            Dimension::dimensionless()
        } else {
            Dimension::new(powers)?
        };
        let unit = Unit::new(symbol, dimension, scale)?;
        let start_ms = self.i64()?;
        let end_ms = match self.byte()? {
            0 => None,
            1 => Some(self.i64()?),
            _ => return Err("invalid temporal end tag".into()),
        };
        Annotation::new(unit, Validity::new(start_ms, end_ms)?, self.string()?)
    }
    fn finished(&self) -> bool {
        self.offset == self.bytes.len()
    }
}

/// A complete, self-contained local snapshot. There is deliberately no GAUSS
/// adapter, network call or physical action in this API.
#[derive(Debug)]
pub struct SemanticArchive {
    pub graph: Graph,
    pub snapshot: SemanticSnapshot,
}

impl SemanticArchive {
    /// Reconstruct rather than trusting a caller's public mutable snapshot
    /// fields. A snapshot attached to different asserted graph data is refused.
    /// Rule changes do not alter the numeric semantic snapshot itself.
    pub fn new(graph: Graph, snapshot: SemanticSnapshot) -> Result<Self, String> {
        let expected = SemanticSnapshot::from_graph(
            &graph,
            snapshot
                .flows
                .iter()
                .map(|item| item.annotation.clone())
                .collect(),
            snapshot
                .restrictions
                .iter()
                .map(|item| item.annotation.clone())
                .collect(),
        )?;
        // `PartialEq` equates +0.0 and -0.0. For source-bound evidence,
        // accepting a changed IEEE-754 payload would silently serialize the
        // original graph instead of the caller's altered public snapshot.
        // Check the exact bits of *all* numeric values in addition to the
        // structural equality check. This is identity, not source authenticity.
        let exact_numbers = expected
            .problem
            .entities
            .iter()
            .zip(&snapshot.problem.entities)
            .all(|(original, supplied)| {
                original.attributes.iter().all(|(key, value)| {
                    match (value, supplied.attributes.get(key)) {
                        (AttributeValue::Number(a), Some(AttributeValue::Number(b))) => {
                            a.to_bits() == b.to_bits()
                        }
                        _ => true,
                    }
                })
            })
            && expected
                .problem
                .flows
                .iter()
                .zip(&snapshot.problem.flows)
                .all(|(a, b)| a.rate_of_transfer.to_bits() == b.rate_of_transfer.to_bits())
            && expected
                .problem
                .restrictions
                .iter()
                .zip(&snapshot.problem.restrictions)
                .all(|(a, b)| a.boundary_value.to_bits() == b.boundary_value.to_bits())
            && expected.flows.iter().zip(&snapshot.flows).all(|(a, b)| {
                a.rate.to_bits() == b.rate.to_bits()
                    && a.annotation.unit.scale_to_reference.to_bits()
                        == b.annotation.unit.scale_to_reference.to_bits()
            })
            && expected
                .restrictions
                .iter()
                .zip(&snapshot.restrictions)
                .all(|(a, b)| {
                    a.boundary.to_bits() == b.boundary.to_bits()
                        && a.annotation.unit.scale_to_reference.to_bits()
                            == b.annotation.unit.scale_to_reference.to_bits()
                });
        if expected != snapshot || !exact_numbers {
            return Err("semantic annotations are not bound to this exact graph".into());
        }
        Ok(Self { graph, snapshot })
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>, String> {
        // Revalidate on every write: fields are public and may have changed.
        Self::new(self.graph.clone(), self.snapshot.clone())?;
        let graph_bytes = self.graph.to_archive_bytes()?;
        if graph_bytes.len() > MAX_GRAPH_BYTES {
            return Err("underlying graph exceeds semantic archive limit".into());
        }
        let mut payload = Writer::default();
        payload.bytes(&graph_bytes)?;
        payload.count(self.snapshot.flows.len())?;
        for flow in &self.snapshot.flows {
            payload.annotation(&flow.annotation)?;
        }
        payload.count(self.snapshot.restrictions.len())?;
        for restriction in &self.snapshot.restrictions {
            payload.annotation(&restriction.annotation)?;
        }
        if payload.1 {
            return Err("semantic archive payload exceeds size limit".into());
        }
        let mut bytes = Vec::with_capacity(HEADER_LENGTH + payload.0.len() + FOOTER_LENGTH);
        bytes.extend_from_slice(MAGIC);
        bytes.extend_from_slice(&VERSION.to_le_bytes());
        bytes.extend_from_slice(&(payload.0.len() as u64).to_le_bytes());
        bytes.extend_from_slice(&payload.0);
        let integrity = checksum(&bytes);
        bytes.extend_from_slice(&integrity.to_le_bytes());
        Ok(bytes)
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() < HEADER_LENGTH + FOOTER_LENGTH || bytes.len() > MAX_ARCHIVE_BYTES {
            return Err("invalid semantic archive size".into());
        }
        if &bytes[..8] != MAGIC {
            return Err("invalid semantic archive magic".into());
        }
        let mut header = Reader::new(&bytes[8..HEADER_LENGTH]);
        if header.u32()? != VERSION {
            return Err("unsupported semantic archive version".into());
        }
        let payload_len =
            usize::try_from(header.u64()?).map_err(|_| "archive payload length overflow")?;
        if payload_len > MAX_GRAPH_BYTES + MAX_METADATA_BYTES
            || payload_len.checked_add(HEADER_LENGTH + FOOTER_LENGTH) != Some(bytes.len())
        {
            return Err("semantic archive length mismatch".into());
        }
        let footer_at = HEADER_LENGTH + payload_len;
        let mut footer = Reader::new(&bytes[footer_at..]);
        if footer.u64()? != checksum(&bytes[..footer_at]) {
            return Err("semantic archive checksum mismatch".into());
        }
        let mut payload = Reader::new(&bytes[HEADER_LENGTH..footer_at]);
        let graph = Graph::from_archive_bytes(payload.blob(MAX_GRAPH_BYTES)?)?;
        let flow_count = payload.count(MAX_ANNOTATIONS)?;
        if flow_count != graph.flows().len() {
            return Err("semantic flow count does not match graph".into());
        }
        let mut flow_annotations = Vec::new();
        for _ in 0..flow_count {
            flow_annotations.push(payload.annotation()?);
        }
        let restriction_count = payload.count(MAX_ANNOTATIONS)?;
        if restriction_count != graph.restrictions().len() {
            return Err("semantic restriction count does not match graph".into());
        }
        let mut restriction_annotations = Vec::new();
        for _ in 0..restriction_count {
            restriction_annotations.push(payload.annotation()?);
        }
        if !payload.finished() {
            return Err("trailing semantic archive bytes".into());
        }
        let snapshot =
            SemanticSnapshot::from_graph(&graph, flow_annotations, restriction_annotations)?;
        let restored = Self::new(graph, snapshot)?;
        // Dimension::new intentionally sorts dimension names. Without this
        // byte check, an alternate wire ordering would be silently accepted
        // and re-encoded into a different evidence record. The unkeyed FNV
        // checksum remains an accidental-corruption check, not authentication.
        if restored.to_bytes()? != bytes {
            return Err("noncanonical semantic archive encoding".into());
        }
        Ok(restored)
    }

    /// Local replacement of a complete archive, not a distributed transaction.
    /// Use a private directory; checksum does not defend against attackers.
    pub fn save_atomic(&self, path: &Path) -> Result<(), String> {
        let bytes = self.to_bytes()?;
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
            ".{}.{}.{}.leibniz-sem-tmp",
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
            #[cfg(unix)]
            File::open(parent)?.sync_all()?;
            Ok(())
        })();
        if outcome.is_err() {
            let _ = fs::remove_file(&temp);
        }
        outcome.map_err(|error| format!("failed to save semantic archive: {error}"))
    }

    pub fn load(path: &Path) -> Result<Self, String> {
        let file =
            File::open(path).map_err(|error| format!("cannot open semantic archive: {error}"))?;
        let mut bytes = Vec::new();
        file.take((MAX_ARCHIVE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("cannot read semantic archive: {error}"))?;
        Self::from_bytes(&bytes)
    }
}

#[cfg(test)]
mod writer_budget_tests {
    use super::*;

    #[test]
    fn semantic_blob_is_rejected_before_prefix_or_payload_is_allocated() {
        let mut writer = Writer(Vec::new(), false, 16);
        writer.0.resize(11, 0);
        let original = writer.0.len();
        assert!(writer.bytes(b"ab").unwrap_err().contains("payload exceeds"));
        assert_eq!(writer.0.len(), original);
        assert!(!writer.1);
    }

    #[test]
    fn fixed_width_annotation_fields_never_exceed_archive_budget() {
        let mut writer = Writer(Vec::new(), false, 16);
        writer.0.resize(15, 0);
        writer.i64(10);
        assert!(writer.1);
        assert_eq!(writer.0.len(), 15);
        assert!(writer.string("data").is_err());
    }

    #[test]
    fn exact_capacity_accepts_last_byte_but_refuses_further_writes() {
        let mut writer = Writer(Vec::new(), false, 16);
        writer.0.resize(15, 0);
        writer.byte(42);
        assert_eq!(writer.0.len(), 16);
        assert!(!writer.1);
        writer.byte(7);
        assert!(writer.1);
        assert_eq!(writer.0.len(), 16);
    }
}
