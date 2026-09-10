use lol_html::{element, html_content::ContentType, HtmlRewriter, Settings};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use worker::*;

const MAX_HTML_BYTES: usize = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = MAX_HTML_BYTES + 512 * 1024;

#[derive(Debug, Deserialize)]
struct TransformPayload {
    html: String,
    vector: RouteVectorSnapshot,
}

#[derive(Debug, Deserialize)]
struct RouteVectorSnapshot {
    site_id: String,
    route: String,
    version: u64,
    sections: BTreeMap<String, SectionSnapshot>,
    output_hash: String,
}

#[derive(Debug, Deserialize)]
struct SectionSnapshot {
    json_ld: Value,
    output_hash: String,
}

#[event(fetch)]
pub async fn main(mut req: Request, _env: Env, _ctx: worker::Context) -> Result<Response> {
    if req.method() != Method::Post || req.path() != "/transform" {
        return Response::error("not found", 404);
    }
    if let Some(length) = req.headers().get("content-length")? {
        if length.parse::<usize>().unwrap_or(MAX_REQUEST_BYTES + 1) > MAX_REQUEST_BYTES {
            return Response::error("payload too large", 413);
        }
    }

    let payload: TransformPayload = req
        .json()
        .await
        .map_err(|e| Error::RustError(format!("invalid transform payload: {e}")))?;
    if payload.html.len() > MAX_HTML_BYTES {
        return Response::error("html too large", 413);
    }
    validate_snapshot(&payload.vector)?;

    let graph = unified_graph(&payload.vector)?;
    let output = rewrite_html(&payload.html, &graph)?;
    let headers = Headers::new();
    headers.set("content-type", "text/html; charset=utf-8")?;
    headers.set("x-nexus-seo-transformer", "rust-wasm-lol-html/3")?;
    headers.set("x-nexus-seo-vector-version", &payload.vector.version.to_string())?;
    headers.set("x-nexus-seo-vector-hash", &payload.vector.output_hash)?;
    Ok(Response::from_bytes(output)?.with_headers(headers))
}

fn validate_snapshot(snapshot: &RouteVectorSnapshot) -> Result<()> {
    if snapshot.site_id.trim().is_empty()
        || !snapshot.route.starts_with('/')
        || snapshot.version == 0
        || !snapshot.output_hash.starts_with("sha256:")
    {
        return Err(Error::RustError("invalid vector snapshot identity".into()));
    }
    for section in snapshot.sections.values() {
        if !section.output_hash.starts_with("sha256:") || !section.json_ld.is_object() {
            return Err(Error::RustError("invalid section vector".into()));
        }
    }
    Ok(())
}

fn unified_graph(snapshot: &RouteVectorSnapshot) -> Result<String> {
    let mut graph: Vec<Value> = Vec::with_capacity(snapshot.sections.len());
    for section in snapshot.sections.values() {
        let mut node = section.json_ld.clone();
        if let Some(object) = node.as_object_mut() {
            object.remove("@context");
        }
        graph.push(node);
    }

    serde_json::to_string(&json!({
        "@context": "https://schema.org",
        "@graph": graph
    }))
    .map_err(|e| Error::RustError(e.to_string()))
}

fn rewrite_html(input: &str, json_ld: &str) -> Result<Vec<u8>> {
    let mut output = Vec::<u8>::with_capacity(input.len() + json_ld.len() + 256);
    let schema = format!(
        r#"<script type="application/ld+json" data-nexus-seo="avengers-50">{json_ld}</script>"#
    );
    let settings = Settings::new()
        .append_element_content_handler(element!("head", move |element| {
            element.append(&schema, ContentType::Html);
            Ok(())
        }))
        .append_element_content_handler(element!("img", |element| {
            element.set_attribute("decoding", "async")?;
            if element.get_attribute("fetchpriority").is_none() {
                element.set_attribute("fetchpriority", "auto")?;
            }
            Ok(())
        }))
        .append_element_content_handler(element!(r#"img[data-lcp="true"]"#, |element| {
            element.set_attribute("decoding", "async")?;
            element.set_attribute("fetchpriority", "high")?;
            element.set_attribute("loading", "eager")?;
            Ok(())
        }))
        .append_element_content_handler(element!("iframe", |element| {
            if element.get_attribute("loading").is_none() {
                element.set_attribute("loading", "lazy")?;
            }
            Ok(())
        }))
        .append_element_content_handler(element!(r#"script[type="text/javascript"]"#, |element| {
            element.remove_attribute("type");
            Ok(())
        }))
        .append_element_content_handler(element!(r#"style[type="text/css"]"#, |element| {
            element.remove_attribute("type");
            Ok(())
        }))
        .append_element_content_handler(element!(r#"link[rel="stylesheet"][type="text/css"]"#, |element| {
            element.remove_attribute("type");
            Ok(())
        }));

    let mut rewriter = HtmlRewriter::new(settings, |chunk: &[u8]| output.extend_from_slice(chunk));
    rewriter
        .write(input.as_bytes())
        .map_err(|e| Error::RustError(format!("lol_html write failed: {e}")))?;
    rewriter
        .end()
        .map_err(|e| Error::RustError(format!("lol_html end failed: {e}")))?;
    drop(rewriter);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_snapshot() {
        let snapshot = RouteVectorSnapshot {
            site_id: "nexus".into(),
            route: "/".into(),
            version: 0,
            sections: BTreeMap::new(),
            output_hash: "bad".into(),
        };
        assert!(validate_snapshot(&snapshot).is_err());
    }
}
