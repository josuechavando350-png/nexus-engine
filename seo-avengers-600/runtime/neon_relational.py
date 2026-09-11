from __future__ import annotations

from typing import Any, Dict, Mapping

from .common import PPM, InvalidData, InsufficientData, clamp_ppm, complement_ppm, need_bool, need_int, ratio_ppm, weighted_ppm


def _score(metric_name: str, metric_ppm: int, threshold_ppm: int, violation: bool, **extra: Any) -> Dict[str, Any]:
    out = {"metric_name": metric_name, "metric_ppm": clamp_ppm(metric_ppm), "threshold_ppm": threshold_ppm,
           "policy_direction": "higher_is_healthier", "violation": bool(violation)}
    out.update(extra)
    return out


def evaluate(operation: str, row: Mapping[str, Any], spec: Mapping[str, Any]) -> Dict[str, Any]:
    threshold_ppm = int(spec["threshold_ppm"])
    if operation == "keyword_cluster_intersection":
        total=need_int(row,"keyword_count",minimum=0); assigned=need_int(row,"canonical_assignment_count",minimum=0)
        if total==0: raise InsufficientData("keyword_count_zero")
        if assigned>total: raise InvalidData("canonical_assignment_count_exceed_keywords")
        score=ratio_ppm(assigned,total); return _score("canonical_assignment_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "semantic_vector_overlap_detector":
        total=need_int(row,"vector_count",minimum=0); conflicts=need_int(row,"overlap_conflict_count",minimum=0)
        if total==0: raise InsufficientData("vector_count_zero")
        if conflicts>total: raise InvalidData("overlap_conflict_count_exceed_vectors")
        score=complement_ppm(ratio_ppm(conflicts,total)); return _score("vector_conflict_health_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "interlinking_authority_writer":
        attempts=need_int(row,"edge_attempt_count",minimum=0); commits=need_int(row,"edge_commit_count",minimum=0)
        if attempts==0: raise InsufficientData("edge_attempt_count_zero")
        if commits>attempts: raise InvalidData("edge_commit_count_exceed_attempts")
        score=ratio_ppm(commits,attempts); return _score("edge_commit_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "slug_history_redirect_consolidator":
        before=need_int(row,"redirect_hops_before",minimum=0); after=need_int(row,"redirect_hops_after",minimum=0)
        if before==0: raise InsufficientData("redirect_hops_before_zero")
        if after>before: raise InvalidData("redirect_hops_after_exceed_before")
        score=ratio_ppm(before-after,before); return _score("redirect_consolidation_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "static_pagerank_batch_calculator":
        nodes=need_int(row,"node_count",minimum=0); converged=need_int(row,"converged_node_count",minimum=0)
        if nodes==0: raise InsufficientData("node_count_zero")
        if converged>nodes: raise InvalidData("converged_node_count_exceed_nodes")
        score=ratio_ppm(converged,nodes); return _score("pagerank_convergence_ppm",score,threshold_ppm,score<threshold_ppm)
    if operation == "deadlock_retry_budget":
        attempts=need_int(row,"retry_attempts",minimum=0); rollback=need_bool(row,"rollback_detected")
        score=max(0,PPM-attempts*250_000); return _score("deadlock_retry_health_ppm",score,threshold_ppm,attempts>3 or rollback,retry_attempts=attempts)

    formula=spec.get("formula"); weight=int(spec.get("concept_weight_ppm",PPM)); dimension=str(spec.get("dimension","")); concept=str(spec.get("concept",""))
    if formula == "ratio":
        if dimension == "utilization":
            observed=need_int(row,"observed_value",minimum=0); capacity=need_int(row,"capacity_value",minimum=1)
            base=complement_ppm(ratio_ppm(min(observed,capacity),capacity))
        elif dimension == "failure_rate":
            failures=need_int(row,"failure_count",minimum=0); samples=need_int(row,"sample_count",minimum=0)
            if samples==0: raise InsufficientData("sample_count_zero")
            if failures>samples: raise InvalidData("failure_count_exceed_sample_count")
            base=complement_ppm(ratio_ppm(failures,samples))
        elif dimension == "recovery_rate":
            recovered=need_int(row,"recovered_count",minimum=0); failures=need_int(row,"failure_count",minimum=0)
            if failures==0: raise InsufficientData("failure_count_zero")
            if recovered>failures: raise InvalidData("recovered_count_exceed_failure_count")
            base=ratio_ppm(recovered,failures)
        elif dimension == "staleness":
            age=need_int(row,"age_seconds",minimum=0); max_age=need_int(row,"max_age_seconds",minimum=1)
            base=PPM if age<=max_age//10 else complement_ppm(ratio_ppm(min(age,max_age),max_age))
        elif dimension == "contention":
            blocked=need_int(row,"blocked_count",minimum=0); active=need_int(row,"active_count",minimum=0)
            if active==0: raise InsufficientData("active_count_zero")
            if blocked>active: raise InvalidData("blocked_count_exceed_active_count")
            base=complement_ppm(ratio_ppm(blocked,active))
        elif dimension == "integrity":
            valid=need_int(row,"valid_count",minimum=0); samples=need_int(row,"sample_count",minimum=0)
            if samples==0: raise InsufficientData("sample_count_zero")
            if valid>samples: raise InvalidData("valid_count_exceed_sample_count")
            base=ratio_ppm(valid,samples)
        else:
            raise InvalidData(f"unsupported_ratio_dimension:{dimension}")
    elif formula == "deviation":
        observed=need_int(row,"observed_value",minimum=0); baseline=need_int(row,"baseline_value",minimum=0)
        if baseline==0: raise InsufficientData("baseline_value_zero")
        base=complement_ppm(ratio_ppm(min(abs(observed-baseline),baseline),baseline))
    elif formula == "skew":
        maximum=need_int(row,"max_bucket_value",minimum=0); median=need_int(row,"median_bucket_value",minimum=0)
        if maximum==0: raise InsufficientData("max_bucket_value_zero")
        if median>maximum: raise InvalidData("median_bucket_value_exceed_max")
        base=ratio_ppm(median,maximum)
    else:
        raise InvalidData(f"unsupported_db_formula:{formula}")

    score=weighted_ppm(base,weight)
    return _score(f"{concept}_{dimension}_health_ppm",score,threshold_ppm,score<threshold_ppm,
                  concept=concept,dimension=dimension,concept_weight_ppm=weight)
