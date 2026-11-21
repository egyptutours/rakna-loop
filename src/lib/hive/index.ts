/**
 * RAKNA HIVE INTELLIGENCE — "Many independent users. Local intelligence. Shared knowledge.
 * Collective efficiency."
 *
 * Service map (modules, not microservices):
 *   HiveMapService           → ./hive-map        (honeycomb styling, legend tokens)
 *   HiveCellService          → ./cells           (H3 hierarchy, neighbors, viewport cover)
 *   SwarmIntelligenceService → ./swarm           (local recruitment, fairness, balancing, roles)
 *   ParkingSignalService     → ./signals         (HIVE RESOURCE SIGNAL + explanation)
 *   SignalVerificationService→ ./verification    (positive/negative feedback trails)
 *   SignalDecayService       → ./decay, ./lifecycle (evaporation, expiry, retention)
 *   LocalDemandService       → ./demand          (anonymous forager demand)
 *   HiveAggregationService   → ./aggregation     (cell summaries, states, cache)
 *   MapQueryService          → ./map-query       (viewport, zoom bands, pagination, clusters)
 */
export * as HiveMapService from "./hive-map";
export * as HiveCellService from "./cells";
export * as SwarmIntelligenceService from "./swarm";
export * as ParkingSignalService from "./signals";
export * as SignalVerificationService from "./verification";
export * as SignalDecayService from "./decay";
export * as DataLifecycleService from "./lifecycle";
export * as LocalDemandService from "./demand";
export * as HiveAggregationService from "./aggregation";
export * as MapQueryService from "./map-query";
