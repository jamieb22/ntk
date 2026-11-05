/** Vitest setup: pin the retrieval env dials BEFORE any src import is
 *  evaluated (DEFAULTS read process.env at module init). Unit fixtures
 *  verify the floor 0.65 and the 3-section doc spread; A2 grid re-picks
 *  (e.g. perDocMax=1, minCoverage=0.8) must not silently change fixture
 *  semantics. Production defaults remain env-driven; grid bakes them. */
process.env.NTK_MIN_COVERAGE ??= "0.65";
process.env.NTK_PER_DOC_MAX ??= "3";
export {};
