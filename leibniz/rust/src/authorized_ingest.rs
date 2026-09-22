//! Bounded, offline ingestion of operator-approved UTF-8 records into LEIBNIZ.
//! The caller, not this module, authenticates the source identity and supplies
//! independently obtained pinned bytes. Byte agreement is NOT a signature,
//! permission check, truth guarantee, or verification of the pin's issuer.
//! No network access or third-party dependency is introduced.
use crate::schema::{Entity, Flow, Restriction, RestrictionType};
use crate::semantic_archive::SemanticArchive;
use crate::semantics::{Annotation, Dimension, SemanticSnapshot, Unit, Validity};
use crate::Graph;
use std::collections::{BTreeSet, HashMap};

pub const SOURCE_PROTOCOL: &str = "LEIBNIZ_SOURCE_V1";
pub const MAX_INPUT_BYTES: usize = 1024 * 1024;
const MAX_RECORDS: usize = 4096;
const MAX_LABEL: usize = 256;

fn label(value: &str) -> Result<&str, String> {
    if value.is_empty() || value.len() > MAX_LABEL || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err("empty, oversized, or control-character source field".into());
    }
    Ok(value)
}

fn source_token(value: &str) -> Result<&str, String> {
    if value.len() > 128
        || !value.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
    {
        return Err("invalid operator-approved source identity".into());
    }
    Ok(value)
}

fn number(value: &str, nonnegative: bool) -> Result<f64, String> {
    if value.is_empty() || value.len() > 64 || !value.bytes().all(|b| {
        b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.' | b'e' | b'E')
    }) {
        return Err("invalid decimal measurement".into());
    }
    let parsed = value.parse::<f64>().map_err(|_| "invalid decimal measurement")?;
    if !parsed.is_finite() || parsed == 0.0 && parsed.is_sign_negative()
        || nonnegative && parsed < 0.0
    {
        return Err("nonfinite, signed-zero, or negative measurement".into());
    }
    Ok(parsed)
}

fn unit(symbol: &str, dimension: &str, scale: &str) -> Result<Unit, String> {
    label(symbol)?;
    if dimension.is_empty() || dimension.len() > 1024 {
        return Err("missing or oversized dimension declaration".into());
    }
    let mut terms = Vec::new();
    for term in dimension.split(',') {
        let (name, exponent) = term.split_once(':').ok_or("invalid dimension term")?;
        source_token(name)?;
        let exponent = exponent.parse::<i16>().map_err(|_| "invalid dimension exponent")?;
        terms.push((name.to_owned(), exponent));
        if terms.len() > 16 {
            return Err("too many base dimensions".into());
        }
    }
    Unit::new(symbol, Dimension::new(terms)?, number(scale, false)?)
}

fn validity(from: &str, until: &str) -> Result<Validity, String> {
    let start = from.parse::<i64>().map_err(|_| "invalid UTC start timestamp")?;
    let end = if until == "*" {
        None
    } else {
        Some(until.parse::<i64>().map_err(|_| "invalid UTC end timestamp")?)
    };
    Validity::new(start, end)
}

fn annotation(
    approved_source_id: &str,
    evidence_id: &str,
    symbol: &str,
    dimension: &str,
    scale: &str,
    start: &str,
    end: &str,
    seen: &mut BTreeSet<String>,
) -> Result<Annotation, String> {
    source_token(evidence_id)?;
    let joined = format!("{approved_source_id}/{evidence_id}");
    if !seen.insert(joined.clone()) {
        return Err("duplicate measurement evidence identifier".into());
    }
    Annotation::new(unit(symbol, dimension, scale)?, validity(start, end)?, joined)
}

/// Exact tab-separated version-1 source format:
/// `LEIBNIZ_SOURCE_V1\tAPPROVED_SOURCE_ID`
/// `ENTITY\tID\tCATEGORY`
/// `FLOW\tFROM\tTO\tDECIMAL_RATE\tUNIT\tDIMENSIONS\tSCALE\tSTART_MS\tEND_MS_OR_*\tEVIDENCE_ID`
/// `RESTRICTION\tFROM\tTO\tIMMUTABLE|CONDITIONAL|ELASTIC\tDECIMAL_BOUNDARY\tUNIT\tDIMENSIONS\tSCALE\tSTART_MS\tEND_MS_OR_*\tEVIDENCE_ID`
/// Dimensions use `base:exponent,base:exponent`, e.g. `contacts:1,time:-1`.
/// Entity declarations MUST precede measurements. No missing values, comments,
/// duplicate measurements, locale-dependent numbers or implicit conversions.
/// Successful return is a complete LEIBNIZ semantic archive, never a forecast.
pub fn ingest_operator_tsv(
    supplied: &[u8],
    independently_pinned: &[u8],
    approved_source_id: &str,
) -> Result<Vec<u8>, String> {
    source_token(approved_source_id)?;
    if supplied.is_empty() || supplied.len() > MAX_INPUT_BYTES
        || supplied != independently_pinned
    {
        return Err("source differs from independently approved byte pin or exceeds limit".into());
    }
    let text = std::str::from_utf8(supplied).map_err(|_| "source is not UTF-8")?;
    if text.contains('\r') || !text.ends_with('\n') {
        return Err("source requires canonical LF-terminated records".into());
    }
    let mut lines = text.split_terminator('\n');
    let first = lines.next().ok_or("missing source protocol header")?;
    if first != format!("{SOURCE_PROTOCOL}\t{approved_source_id}") {
        return Err("source header does not match approved identity or version".into());
    }
    let mut graph = Graph::new();
    let mut flows = Vec::new();
    let mut restrictions = Vec::new();
    let mut evidence = BTreeSet::new();
    let mut record_count = 0usize;
    let mut measurements_started = false;
    for line in lines {
        record_count += 1;
        if record_count > MAX_RECORDS || line.is_empty() || line.len() > 2048 {
            return Err("empty, oversized, or excessive source record".into());
        }
        let fields = line.split('\t').collect::<Vec<_>>();
        match fields.as_slice() {
            ["ENTITY", id, category] if !measurements_started => {
                graph.add_entity(Entity {
                    id: label(id)?.into(),
                    category: label(category)?.into(),
                    attributes: HashMap::new(),
                })?;
            }
            ["FLOW", from, to, rate, symbol, dims, scale, start, end, id] => {
                measurements_started = true;
                label(from)?;
                label(to)?;
                let parsed = number(rate, true)?;
                let annotated = annotation(approved_source_id, id, symbol, dims, scale, start,
                    end, &mut evidence)?;
                graph.add_flow(Flow {
                    from_entity: (*from).into(),
                    to_entity: (*to).into(),
                    rate_of_transfer: parsed,
                })?;
                flows.push(annotated);
            }
            ["RESTRICTION", from, to, kind, boundary, symbol, dims, scale, start, end, id] => {
                measurements_started = true;
                label(from)?;
                label(to)?;
                let constraint_type = match *kind {
                    "IMMUTABLE" => RestrictionType::Immutable,
                    "CONDITIONAL" => RestrictionType::Conditional,
                    "ELASTIC" => RestrictionType::Elastic,
                    _ => return Err("invalid restriction category".into()),
                };
                let parsed = number(boundary, false)?;
                let annotated = annotation(approved_source_id, id, symbol, dims, scale, start,
                    end, &mut evidence)?;
                graph.add_restriction(Restriction {
                    source_id: (*from).into(),
                    target_id: (*to).into(),
                    constraint_type,
                    boundary_value: parsed,
                })?;
                restrictions.push(annotated);
            }
            _ => return Err("invalid source record, field count, or entity ordering".into()),
        }
    }
    if record_count == 0 || flows.is_empty() && restrictions.is_empty() {
        return Err("source requires entities and at least one numeric record".into());
    }
    let snapshot = SemanticSnapshot::from_graph(&graph, flows, restrictions)?;
    SemanticArchive::new(graph, snapshot)?.to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(rate: &str) -> Vec<u8> {
        format!("{SOURCE_PROTOCOL}\toperator-allowed\nENTITY\tsource\tOrganization\nENTITY\tleft\tChannel\nENTITY\tright\tChannel\nFLOW\tsource\tleft\t{rate}\tcontacts/s\tcontacts:1,time:-1\t1\t100\t200\tleft-2026\nFLOW\tsource\tright\t7.25\tcontacts/s\tcontacts:1,time:-1\t1\t100\t200\tright-2026\nRESTRICTION\tsource\tleft\tELASTIC\t12\tcontacts\tcontacts:1\t1\t100\t*\tconstraint-2026\n").into_bytes()
    }
    #[test]
    fn approved_source_becomes_typed_replayable_archive_with_all_three_models() {
        let raw = source("2.5");
        let blob = ingest_operator_tsv(&raw, &raw, "operator-allowed").unwrap();
        let archive = SemanticArchive::from_bytes(&blob).unwrap();
        assert_eq!(archive.snapshot.problem.entities.len(), 3);
        assert_eq!(archive.snapshot.flows.len(), 2);
        assert_eq!(archive.snapshot.restrictions.len(), 1);
        assert_eq!(archive.snapshot.flows[0].rate, 2.5);
        assert_eq!(archive.snapshot.flows[0].annotation.evidence_id, "operator-allowed/left-2026");
        assert_eq!(archive.snapshot.restrictions[0].boundary, 12.0);
        assert_eq!(archive.to_bytes().unwrap(), blob);
    }
    #[test]
    fn source_mutation_and_wrong_operator_identity_are_rejected() {
        let original = source("2.5");
        let changed = source("99");
        assert!(ingest_operator_tsv(&changed, &original, "operator-allowed").is_err());
        assert!(ingest_operator_tsv(&original, &original, "intruder").is_err());
        assert!(ingest_operator_tsv(&original, b"", "operator-allowed").is_err());
    }
    #[test]
    fn malformed_numeric_source_and_duplicate_evidence_fail_closed() {
        for value in ["NaN", "-1", "-0", "1,2", "1e999"] {
            let input = source(value);
            assert!(ingest_operator_tsv(&input, &input, "operator-allowed").is_err(), "{value}");
        }
        let input = source("2.5");
        let duplicate = String::from_utf8(input).unwrap().replace("right-2026", "left-2026");
        assert!(ingest_operator_tsv(duplicate.as_bytes(), duplicate.as_bytes(), "operator-allowed").is_err());
    }
    #[test]
    fn record_order_unknown_entities_and_invalid_dimension_are_refused() {
        let original = String::from_utf8(source("2.5")).unwrap();
        for altered in [
            original.replace("ENTITY\tleft\tChannel\n", ""),
            original.replace("contacts:1,time:-1", "contacts:1,time:0"),
            original.replace("ENTITY\tsource\tOrganization", "UNKNOWN\tsource\tOrganization"),
            original.replace("\t100\t200\tleft-2026", "\t200\t100\tleft-2026"),
        ] {
            assert!(ingest_operator_tsv(altered.as_bytes(), altered.as_bytes(), "operator-allowed").is_err());
        }
    }
    #[test]
    fn oversized_input_and_noncanonical_line_endings_are_refused() {
        let large = vec![b'a'; MAX_INPUT_BYTES + 1];
        assert!(ingest_operator_tsv(&large, &large, "operator-allowed").is_err());
        let raw = source("2.5");
        let crlf = String::from_utf8(raw).unwrap().replace('\n', "\r\n");
        assert!(ingest_operator_tsv(crlf.as_bytes(), crlf.as_bytes(), "operator-allowed").is_err());
    }
}
