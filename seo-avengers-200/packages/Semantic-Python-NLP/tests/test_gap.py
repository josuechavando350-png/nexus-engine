from main import RawEntity, aggregate_gap


def test_gap_prioritizes_missing_entity():
    target = [RawEntity("Nexus", 0.2, "ORGANIZATION", {})]
    competitors = [
        [RawEntity("Nexus", 0.1, "ORGANIZATION", {}), RawEntity("PageRank", 0.3, "OTHER", {})],
        [RawEntity("PageRank", 0.4, "OTHER", {})],
    ]
    gaps, total = aggregate_gap(target, competitors)
    assert total > 0
    assert gaps[0].name == "PageRank"
