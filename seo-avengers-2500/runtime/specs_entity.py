from __future__ import annotations
from typing import Any
from .specs_common import add

def build(rows: list[dict[str, Any]]) -> None:
    nap_fields=(("name","business name"),("address","business address"),("phone","business phone"))
    scopes=(("all_documents","all","across the content corpus"),
            ("commercial_documents","commercial","on pages receiving commercial-intent demand"),
            ("service_documents","service","on pages receiving service-intent demand"),
            ("location_documents","location","on pages receiving location-qualified demand"),
            ("top_demand_documents","top_demand","on pages with the most observed impressions"))
    for field,label in nap_fields:
        for scope,mode,description in scopes:
            add(rows,"LOCAL_ENTITY",f"{field}_{scope}_corroboration","MULTI","nap_content_corroboration",
                {"field":field,"scope":mode},
                f"Corroborate the normalized {label} from local business evidence {description}; never rewrite content.",
                (),900_000)

    for field,label in nap_fields:
        add(rows,"LOCAL_ENTITY",f"{field}_source_quorum_strength","local_business_records","local_field_quorum",
            {"field":field,"min_sources":2},
            f"Measure independent-source agreement on the modal normalized {label}, beyond pairwise consistency.",(),900_000)
        add(rows,"LOCAL_ENTITY",f"{field}_source_quorum_outlier_isolation","local_business_records","local_field_outliers",
            {"field":field,"min_sources":3},
            f"Isolate supplied sources whose normalized {label} disagrees with the modal quorum.",(),900_000)
    for left,right in (("name","address"),("name","phone"),("address","phone"),("latitude_e6","longitude_e6")):
        add(rows,"LOCAL_ENTITY",f"{left}_{right}_joint_presence_quorum","local_business_records","local_joint_presence",
            {"fields":[left,right]},f"Audit whether local records carry both {left} and {right} together.",(),900_000)

    entity_query=(
        ("business_name_query_presence","name","brand","Measure whether brand-intent queries can be corroborated against the supplied business name."),
        ("address_query_locality_presence","address","location","Measure whether location-qualified demand uses locality/address tokens corroborated by local evidence."),
        ("phone_query_identity_safety","phone","brand","Ensure phone-like identity signals are not inferred from demand unless corroborated by local records."),
        ("name_service_query_alignment","name","service","Measure whether service-intent demand is attached to the verified business identity."),
        ("address_service_query_alignment","address","service","Measure whether service-intent demand intersects verified locality tokens from the address."),
    )
    for operation,field,intent,purpose in entity_query:
        cfg=f"local_{intent}_terms"
        add(rows,"LOCAL_ENTITY",operation,"MULTI","query_entity_alignment",{"field":field,"intent_config":cfg},purpose,(cfg,),850_000)
        add(rows,"LOCAL_ENTITY",operation+"_high_demand","MULTI","query_entity_alignment",
            {"field":field,"intent_config":cfg,"min_impressions":100},purpose+" Restrict to materially observed demand.",(cfg,),900_000)

    add(rows,"LOCAL_ENTITY","local_source_identifier_uniqueness","local_business_records","local_source_id_uniqueness",{},
        "Detect conflicting duplicate source identifiers so evidence cannot silently overwrite another record.",(),1_000_000)
    add(rows,"LOCAL_ENTITY","local_source_count_floor","local_business_records","local_source_count",{"min_sources":2},
        "Require more than one local observation before cross-source consistency is considered corroborated.",(),900_000)
    add(rows,"LOCAL_ENTITY","nap_complete_source_share","local_business_records","local_complete_record_share",
        {"fields":["name","address","phone"]},"Measure the share of sources containing complete NAP identity.",(),900_000)
    add(rows,"LOCAL_ENTITY","nap_geo_complete_source_share","local_business_records","local_complete_record_share",
        {"fields":["name","address","phone","latitude_e6","longitude_e6"]},"Measure sources jointly providing NAP and coordinates.",(),900_000)
    add(rows,"LOCAL_ENTITY","nap_quorum_geo_corroboration","local_business_records","local_nap_geo_corroboration",
        {"max_l1_e6":10_000},"Require coordinate outliers to be corroborated with NAP disagreement before treating them as local-entity drift.",(),950_000)
    add(rows,"LOCAL_ENTITY","nap_coordinate_joint_outlier_detector","local_business_records","local_nap_geo_joint_outliers",
        {"max_l1_e6":10_000},"Find sources that disagree with both modal NAP identity and coordinate quorum.",(),950_000)
    add(rows,"LOCAL_ENTITY","address_coordinate_disagreement_detector","local_business_records","local_address_geo_disagreement",
        {"max_l1_e6":10_000},"Detect identical normalized addresses paired with materially different coordinates.",(),950_000)
    add(rows,"LOCAL_ENTITY","phone_coordinate_disagreement_detector","local_business_records","local_phone_geo_disagreement",
        {"max_l1_e6":10_000},"Detect the same normalized phone paired with materially different coordinates.",(),950_000)

    for operation,field,purpose in (
        ("primary_identity_content_coverage","name","Measure corpus coverage of the verified business name."),
        ("primary_address_content_coverage","address","Measure corpus coverage of verified address tokens."),
        ("primary_phone_content_coverage","phone","Measure corpus coverage of the verified business phone."),
        ("nap_triplet_content_cooccurrence","triplet","Measure documents where verified name, address and phone co-occur."),
        ("local_entity_document_dispersion","name","Measure whether verified local identity is concentrated on too few documents."),
        ("local_entity_query_page_bridge","name","Measure whether pages receiving local demand contain corroborated business identity evidence."),
        ("local_entity_conflicting_claim_detector","triplet","Detect content documents containing a different NAP claim from the local-record quorum."),
    ):
        add(rows,"LOCAL_ENTITY",operation,"MULTI","local_entity_content_metric",{"metric":operation,"field":field},purpose,(),900_000)
