//! Contract for computer-vision output produced **outside** this runtime.
//!
//! NEXUS V3 does not train or run a vision model. It defines the boundary a
//! third-party detector must satisfy, validates it, and gives the result
//! provenance so a downstream task can be traced back to the frame that
//! caused it.
//!
//! ## Safety boundary
//!
//! [`DetectionClass`] is a **closed** set of industrial conditions. There is
//! no person class, no identity class, no tracking-of-individuals class, and
//! `parse` rejects anything outside the set rather than falling back to an
//! `Other` variant. This is deliberate: an open enum here would be the seam
//! through which person-targeting could enter the pipeline. A detector that
//! wants to report something new has to change this file, in review.
//!
//! A person appearing in frame is relevant to industrial safety only as a
//! zone-occupancy condition — expressed as
//! [`DetectionClass::PersonnelPresenceInRestrictedZone`], which carries no
//! identity, no bounding-box tracking across frames and no re-identification.
//! It exists so a robot can be told to *stop*, never so anything can be told
//! to follow.

use crate::error::{NexusError, Result};
use crate::ids::{EntityId, SourceId, TraceId};
use crate::json::Value;
use crate::time::Timestamp;

/// Closed set of industrial detection classes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum DetectionClass {
    Smoke,
    Fire,
    LiquidLeak,
    GasLeak,
    Overheating,
    Pallet,
    Vehicle,
    ObjectOutOfZone,
    EquipmentStopped,
    Obstruction,
    StructuralCrack,
    CorrosionPatch,
    SpillOnFloor,
    /// Safety-relevant occupancy only. No identity, no re-identification,
    /// no cross-frame tracking of individuals.
    PersonnelPresenceInRestrictedZone,
}

impl DetectionClass {
    pub fn as_str(self) -> &'static str {
        match self {
            DetectionClass::Smoke => "smoke",
            DetectionClass::Fire => "fire",
            DetectionClass::LiquidLeak => "liquid_leak",
            DetectionClass::GasLeak => "gas_leak",
            DetectionClass::Overheating => "overheating",
            DetectionClass::Pallet => "pallet",
            DetectionClass::Vehicle => "vehicle",
            DetectionClass::ObjectOutOfZone => "object_out_of_zone",
            DetectionClass::EquipmentStopped => "equipment_stopped",
            DetectionClass::Obstruction => "obstruction",
            DetectionClass::StructuralCrack => "structural_crack",
            DetectionClass::CorrosionPatch => "corrosion_patch",
            DetectionClass::SpillOnFloor => "spill_on_floor",
            DetectionClass::PersonnelPresenceInRestrictedZone => {
                "personnel_presence_in_restricted_zone"
            }
        }
    }

    /// Rejects unknown classes instead of widening the set at runtime.
    pub fn parse(value: &str) -> Result<Self> {
        Ok(match value {
            "smoke" => DetectionClass::Smoke,
            "fire" => DetectionClass::Fire,
            "liquid_leak" => DetectionClass::LiquidLeak,
            "gas_leak" => DetectionClass::GasLeak,
            "overheating" => DetectionClass::Overheating,
            "pallet" => DetectionClass::Pallet,
            "vehicle" => DetectionClass::Vehicle,
            "object_out_of_zone" => DetectionClass::ObjectOutOfZone,
            "equipment_stopped" => DetectionClass::EquipmentStopped,
            "obstruction" => DetectionClass::Obstruction,
            "structural_crack" => DetectionClass::StructuralCrack,
            "corrosion_patch" => DetectionClass::CorrosionPatch,
            "spill_on_floor" => DetectionClass::SpillOnFloor,
            "personnel_presence_in_restricted_zone" => {
                DetectionClass::PersonnelPresenceInRestrictedZone
            }
            other => {
                return Err(NexusError::denied(format!(
                    "detection class '{other}' is not in the industrial allowlist"
                )))
            }
        })
    }

    /// Classes that on their own justify raising an incident.
    pub fn is_hazard(self) -> bool {
        matches!(
            self,
            DetectionClass::Smoke
                | DetectionClass::Fire
                | DetectionClass::LiquidLeak
                | DetectionClass::GasLeak
                | DetectionClass::Overheating
                | DetectionClass::SpillOnFloor
                | DetectionClass::PersonnelPresenceInRestrictedZone
        )
    }

    /// Classes that must force any in-flight physical task to stop rather
    /// than continue, regardless of what the plan said.
    pub fn forces_safe_stop(self) -> bool {
        matches!(
            self,
            DetectionClass::PersonnelPresenceInRestrictedZone | DetectionClass::Fire
        )
    }

    pub fn all() -> &'static [DetectionClass] {
        &[
            DetectionClass::Smoke,
            DetectionClass::Fire,
            DetectionClass::LiquidLeak,
            DetectionClass::GasLeak,
            DetectionClass::Overheating,
            DetectionClass::Pallet,
            DetectionClass::Vehicle,
            DetectionClass::ObjectOutOfZone,
            DetectionClass::EquipmentStopped,
            DetectionClass::Obstruction,
            DetectionClass::StructuralCrack,
            DetectionClass::CorrosionPatch,
            DetectionClass::SpillOnFloor,
            DetectionClass::PersonnelPresenceInRestrictedZone,
        ]
    }
}

/// Normalized bounding box in frame coordinates, `0.0..=1.0`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BoundingBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl BoundingBox {
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Result<Self> {
        let candidate = BoundingBox {
            x,
            y,
            width,
            height,
        };
        candidate.validate()?;
        Ok(candidate)
    }

    pub fn validate(&self) -> Result<()> {
        for (name, value) in [
            ("x", self.x),
            ("y", self.y),
            ("width", self.width),
            ("height", self.height),
        ] {
            if !value.is_finite() {
                return Err(NexusError::schema(format!("bbox.{name} must be finite")));
            }
        }
        if self.width <= 0.0 || self.height <= 0.0 {
            return Err(NexusError::schema("bbox must have positive extent"));
        }
        if self.x < 0.0 || self.y < 0.0 || self.x + self.width > 1.0 || self.y + self.height > 1.0 {
            return Err(NexusError::schema(
                "bbox must be normalized inside the unit frame",
            ));
        }
        Ok(())
    }

    pub fn area(&self) -> f64 {
        self.width * self.height
    }

    /// Intersection-over-union, used to correlate detections of the same
    /// condition reported by overlapping cameras.
    pub fn iou(&self, other: &BoundingBox) -> f64 {
        let x1 = self.x.max(other.x);
        let y1 = self.y.max(other.y);
        let x2 = (self.x + self.width).min(other.x + other.width);
        let y2 = (self.y + self.height).min(other.y + other.height);
        if x2 <= x1 || y2 <= y1 {
            return 0.0;
        }
        let intersection = (x2 - x1) * (y2 - y1);
        let union = self.area() + other.area() - intersection;
        if union <= 0.0 {
            0.0
        } else {
            intersection / union
        }
    }

    fn to_json(self) -> Value {
        Value::object(vec![
            ("x", Value::number(self.x)),
            ("y", Value::number(self.y)),
            ("width", Value::number(self.width)),
            ("height", Value::number(self.height)),
        ])
    }
}

/// A single detection produced by an external model.
#[derive(Debug, Clone, PartialEq)]
pub struct Detection {
    pub model_id: String,
    pub frame_id: String,
    pub class: DetectionClass,
    pub confidence: f64,
    pub bbox: Option<BoundingBox>,
    pub timestamp: Timestamp,
    pub source_sensor: SourceId,
    /// Asset or zone the detector believes it saw, if it knows. Resolution to
    /// a real entity happens in `nexus-ontology`, not here.
    pub subject_hint: Option<String>,
    pub trace_id: Option<TraceId>,
}

impl Detection {
    pub fn validate(&self) -> Result<()> {
        if self.model_id.is_empty() || self.model_id.len() > 128 {
            return Err(NexusError::schema("model_id must be 1..=128 characters"));
        }
        if self.frame_id.is_empty() || self.frame_id.len() > 128 {
            return Err(NexusError::schema("frame_id must be 1..=128 characters"));
        }
        if !self.confidence.is_finite() || !(0.0..=1.0).contains(&self.confidence) {
            return Err(NexusError::schema("confidence must be within 0.0..=1.0"));
        }
        if self.timestamp.as_millis() <= 0 {
            return Err(NexusError::schema("timestamp must be a positive epoch"));
        }
        if let Some(bbox) = &self.bbox {
            bbox.validate()?;
        }
        Ok(())
    }

    /// Stable identity for a detection, so a redelivered frame result does
    /// not create a second Detection node in the graph.
    pub fn entity_id(&self) -> EntityId {
        EntityId::derive_from(&[
            "Detection",
            &self.model_id,
            &self.frame_id,
            self.class.as_str(),
            self.source_sensor.as_str(),
        ])
    }

    /// Whether two detections plausibly describe the same physical condition.
    ///
    /// Deterministic and explainable on purpose: same class, close in time,
    /// and either overlapping boxes or a shared subject hint. No learned
    /// similarity model is involved, and none is implied.
    pub fn correlates_with(&self, other: &Detection, window_millis: i64, min_iou: f64) -> bool {
        if self.class != other.class {
            return false;
        }
        if self.timestamp.delta_millis(other.timestamp).abs() > window_millis {
            return false;
        }
        if let (Some(left), Some(right)) = (&self.bbox, &other.bbox) {
            if self.source_sensor == other.source_sensor && left.iou(right) >= min_iou {
                return true;
            }
        }
        match (&self.subject_hint, &other.subject_hint) {
            (Some(left), Some(right)) => left == right,
            _ => false,
        }
    }

    pub fn to_json(&self) -> Value {
        Value::object(vec![
            ("model_id", Value::string(&self.model_id)),
            ("frame_id", Value::string(&self.frame_id)),
            ("class", Value::string(self.class.as_str())),
            ("confidence", Value::number(self.confidence)),
            (
                "bbox",
                match self.bbox {
                    Some(bbox) => bbox.to_json(),
                    None => Value::Null,
                },
            ),
            (
                "timestamp",
                Value::number(self.timestamp.as_millis() as f64),
            ),
            ("source_sensor", Value::string(self.source_sensor.as_str())),
            (
                "subject_hint",
                match &self.subject_hint {
                    Some(hint) => Value::string(hint),
                    None => Value::Null,
                },
            ),
        ])
    }

    pub fn from_json(value: &Value) -> Result<Self> {
        let bbox = match value.get("bbox") {
            None | Some(Value::Null) => None,
            Some(node) => Some(BoundingBox::new(
                node.require_f64("x")?,
                node.require_f64("y")?,
                node.require_f64("width")?,
                node.require_f64("height")?,
            )?),
        };
        let subject_hint = match value.get("subject_hint") {
            None | Some(Value::Null) => None,
            Some(node) => Some(
                node.as_str()
                    .ok_or_else(|| NexusError::schema("subject_hint must be a string"))?
                    .to_string(),
            ),
        };

        let detection = Detection {
            model_id: value.require_str("model_id")?.to_string(),
            frame_id: value.require_str("frame_id")?.to_string(),
            class: DetectionClass::parse(value.require_str("class")?)?,
            confidence: value.require_f64("confidence")?,
            bbox,
            timestamp: Timestamp::from_millis(value.require_f64("timestamp")? as i64),
            source_sensor: SourceId::from_external(value.require_str("source_sensor")?),
            subject_hint,
            trace_id: None,
        };
        detection.validate()?;
        Ok(detection)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detection(class: DetectionClass, confidence: f64) -> Detection {
        Detection {
            model_id: "yolo-industrial-v7".into(),
            frame_id: "frame-000123".into(),
            class,
            confidence,
            bbox: Some(BoundingBox::new(0.1, 0.1, 0.2, 0.2).unwrap()),
            timestamp: Timestamp::from_millis(1_700_000_000_000),
            source_sensor: SourceId::from_external("cam-north-02"),
            subject_hint: Some("press-04".into()),
            trace_id: None,
        }
    }

    #[test]
    fn detection_class_set_is_closed() {
        for class in DetectionClass::all() {
            assert_eq!(DetectionClass::parse(class.as_str()).unwrap(), *class);
        }
        for rejected in ["person", "face", "soldier", "target", "license_plate", ""] {
            let error = DetectionClass::parse(rejected).unwrap_err();
            assert_eq!(error.kind(), "denied", "must reject class {rejected:?}");
        }
    }

    #[test]
    fn personnel_presence_forces_a_safe_stop() {
        assert!(DetectionClass::PersonnelPresenceInRestrictedZone.forces_safe_stop());
        assert!(DetectionClass::PersonnelPresenceInRestrictedZone.is_hazard());
        assert!(!DetectionClass::Pallet.forces_safe_stop());
    }

    #[test]
    fn bounding_box_must_be_normalized() {
        assert!(BoundingBox::new(0.0, 0.0, 1.0, 1.0).is_ok());
        assert!(BoundingBox::new(-0.1, 0.0, 0.5, 0.5).is_err());
        assert!(BoundingBox::new(0.8, 0.0, 0.5, 0.5).is_err());
        assert!(BoundingBox::new(0.0, 0.0, 0.0, 0.5).is_err());
        assert!(BoundingBox::new(f64::NAN, 0.0, 0.5, 0.5).is_err());
    }

    #[test]
    fn iou_is_zero_for_disjoint_boxes_and_one_for_identical() {
        let a = BoundingBox::new(0.0, 0.0, 0.2, 0.2).unwrap();
        let b = BoundingBox::new(0.5, 0.5, 0.2, 0.2).unwrap();
        assert_eq!(a.iou(&b), 0.0);
        assert!((a.iou(&a) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn confidence_outside_the_unit_interval_is_rejected() {
        assert!(detection(DetectionClass::Smoke, 1.5).validate().is_err());
        assert!(detection(DetectionClass::Smoke, -0.1).validate().is_err());
        assert!(detection(DetectionClass::Smoke, 0.87).validate().is_ok());
    }

    #[test]
    fn detection_identity_is_content_derived() {
        let first = detection(DetectionClass::Smoke, 0.9);
        let second = detection(DetectionClass::Smoke, 0.4);
        // Confidence is not part of identity: the same frame re-scored is
        // still the same detection.
        assert_eq!(first.entity_id(), second.entity_id());
    }

    #[test]
    fn correlation_requires_same_class_and_time_window() {
        let smoke = detection(DetectionClass::Smoke, 0.9);
        let mut later = detection(DetectionClass::Smoke, 0.8);
        later.timestamp = Timestamp::from_millis(1_700_000_002_000);
        assert!(smoke.correlates_with(&later, 5_000, 0.3));
        assert!(!smoke.correlates_with(&later, 1_000, 0.3));

        let other_class = detection(DetectionClass::Pallet, 0.9);
        assert!(!smoke.correlates_with(&other_class, 5_000, 0.3));
    }

    #[test]
    fn json_round_trip() {
        let original = detection(DetectionClass::GasLeak, 0.66);
        let decoded = Detection::from_json(&original.to_json()).unwrap();
        assert_eq!(decoded.class, original.class);
        assert_eq!(decoded.frame_id, original.frame_id);
        assert_eq!(decoded.bbox, original.bbox);
        assert_eq!(decoded.entity_id(), original.entity_id());
    }

    #[test]
    fn json_decoding_rejects_a_person_targeting_class() {
        let hostile = crate::json::parse(
            r#"{"model_id":"m","frame_id":"f","class":"person","confidence":0.9,
                "timestamp":1700000000000,"source_sensor":"cam-1"}"#,
        )
        .unwrap();
        assert!(Detection::from_json(&hostile).is_err());
    }
}
