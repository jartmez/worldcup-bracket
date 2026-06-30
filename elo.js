/* elo.js — World Football Elo ratings for the 32 Round-of-32 teams.
 *
 * Source: eloratings.net (World Football Elo Ratings), the standard public
 * Elo for men's national teams. Pulled from their published 2026 ratings
 * table (the site's 2026.tsv data file).
 * As-of date: 2026-06-29 (one day before the current build date), so these are
 * the live, current ratings, not a stale snapshot.
 *
 * Keyed by FIFA 3-letter code. Used only as a model input for win
 * probabilities; clearly a model estimate, not betting odds. */
window.WC_ELO = {
  source: 'eloratings.net (World Football Elo Ratings)',
  asOf: '2026-06-29',
  note: 'Model estimate only. Not betting odds.',
  ratings: {
    ARG: 2148, ESP: 2144, FRA: 2123, ENG: 2038, BRA: 2009, COL: 2004,
    POR: 1990, NED: 1980, NOR: 1918, GER: 1916, SUI: 1914, MEX: 1912,
    JPN: 1910, CRO: 1905, ECU: 1902, BEL: 1884, MAR: 1877, SEN: 1842,
    AUT: 1836, PAR: 1815, AUS: 1800, ALG: 1785, USA: 1781, CAN: 1764,
    CIV: 1743, SWE: 1742, EGY: 1742, COD: 1712, BIH: 1622, CPV: 1622,
    GHA: 1575, RSA: 1559
  }
};
