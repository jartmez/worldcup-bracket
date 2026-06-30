/* data.js — team reference data.
 * FIFA uses 3-letter codes (ENG, ALG, CPV...) that differ from the ISO 3166-1
 * alpha-2 codes the flag CDN keys on (gb-eng, dz, cv...). This table is the
 * authoritative FIFA -> {name, iso} mapping, reused by the live data layer in
 * step 3 so API teams resolve to the correct flag. */
(function (global) {
  'use strict';

  // FIFA TLA -> { name, iso }. iso is the circle-flags / ISO 3166-1 alpha-2 key
  // (with gb-eng / gb-sct / gb-wls / gb-nir for the home nations).
  var FIFA = {
    // UEFA
    GER: { name: 'Germany', iso: 'de' },
    FRA: { name: 'France', iso: 'fr' },
    ESP: { name: 'Spain', iso: 'es' },
    POR: { name: 'Portugal', iso: 'pt' },
    NED: { name: 'Netherlands', iso: 'nl' },
    BEL: { name: 'Belgium', iso: 'be' },
    ITA: { name: 'Italy', iso: 'it' },
    ENG: { name: 'England', iso: 'gb-eng' },
    SCO: { name: 'Scotland', iso: 'gb-sct' },
    WAL: { name: 'Wales', iso: 'gb-wls' },
    NIR: { name: 'Northern Ireland', iso: 'gb-nir' },
    CRO: { name: 'Croatia', iso: 'hr' },
    SUI: { name: 'Switzerland', iso: 'ch' },
    AUT: { name: 'Austria', iso: 'at' },
    SWE: { name: 'Sweden', iso: 'se' },
    NOR: { name: 'Norway', iso: 'no' },
    DEN: { name: 'Denmark', iso: 'dk' },
    POL: { name: 'Poland', iso: 'pl' },
    UKR: { name: 'Ukraine', iso: 'ua' },
    SRB: { name: 'Serbia', iso: 'rs' },
    CZE: { name: 'Czechia', iso: 'cz' },
    TUR: { name: 'Turkiye', iso: 'tr' },
    GRE: { name: 'Greece', iso: 'gr' },
    ROU: { name: 'Romania', iso: 'ro' },
    HUN: { name: 'Hungary', iso: 'hu' },
    SVN: { name: 'Slovenia', iso: 'si' },
    SVK: { name: 'Slovakia', iso: 'sk' },
    BIH: { name: 'Bosnia & Herzegovina', iso: 'ba' },
    // CAF
    MAR: { name: 'Morocco', iso: 'ma' },
    SEN: { name: 'Senegal', iso: 'sn' },
    RSA: { name: 'South Africa', iso: 'za' },
    CIV: { name: "Cote d'Ivoire", iso: 'ci' },
    COD: { name: 'DR Congo', iso: 'cd' },
    CPV: { name: 'Cape Verde', iso: 'cv' },
    EGY: { name: 'Egypt', iso: 'eg' },
    ALG: { name: 'Algeria', iso: 'dz' },
    GHA: { name: 'Ghana', iso: 'gh' },
    NGA: { name: 'Nigeria', iso: 'ng' },
    CMR: { name: 'Cameroon', iso: 'cm' },
    TUN: { name: 'Tunisia', iso: 'tn' },
    MLI: { name: 'Mali', iso: 'ml' },
    // CONMEBOL
    BRA: { name: 'Brazil', iso: 'br' },
    ARG: { name: 'Argentina', iso: 'ar' },
    URU: { name: 'Uruguay', iso: 'uy' },
    COL: { name: 'Colombia', iso: 'co' },
    ECU: { name: 'Ecuador', iso: 'ec' },
    PAR: { name: 'Paraguay', iso: 'py' },
    CHI: { name: 'Chile', iso: 'cl' },
    PER: { name: 'Peru', iso: 'pe' },
    // CONCACAF
    USA: { name: 'United States', iso: 'us' },
    MEX: { name: 'Mexico', iso: 'mx' },
    CAN: { name: 'Canada', iso: 'ca' },
    CRC: { name: 'Costa Rica', iso: 'cr' },
    HON: { name: 'Honduras', iso: 'hn' },
    PAN: { name: 'Panama', iso: 'pa' },
    JAM: { name: 'Jamaica', iso: 'jm' },
    // AFC
    JPN: { name: 'Japan', iso: 'jp' },
    KOR: { name: 'South Korea', iso: 'kr' },
    AUS: { name: 'Australia', iso: 'au' },
    IRN: { name: 'Iran', iso: 'ir' },
    KSA: { name: 'Saudi Arabia', iso: 'sa' },
    QAT: { name: 'Qatar', iso: 'qa' },
    UAE: { name: 'United Arab Emirates', iso: 'ae' },
    IRQ: { name: 'Iraq', iso: 'iq' },
    JOR: { name: 'Jordan', iso: 'jo' },
    UZB: { name: 'Uzbekistan', iso: 'uz' },
    // OFC
    NZL: { name: 'New Zealand', iso: 'nz' },
    // other group-stage nations (so any team resolves)
    HAI: { name: 'Haiti', iso: 'ht' },
    CUW: { name: 'Curacao', iso: 'cw' }
  };

  // Placeholder seed order (clockwise from top). Replaced by live fixtures in step 3.
  var PLACEHOLDER = [
    'GER', 'PAR', 'FRA', 'SWE', 'RSA', 'CAN', 'NED', 'MAR',
    'POR', 'CRO', 'ESP', 'AUT', 'USA', 'BIH', 'BEL', 'SEN',
    'BRA', 'JPN', 'CIV', 'NOR', 'MEX', 'ECU', 'ENG', 'COD',
    'ARG', 'CPV', 'AUS', 'EGY', 'SUI', 'ALG', 'COL', 'GHA'
  ];

  // circle-flags via jsDelivr CDN (already circular SVGs with transparent corners).
  function flagUrl(iso) {
    return 'https://cdn.jsdelivr.net/gh/HatScripts/circle-flags/flags/' + iso + '.svg';
  }

  function teamByFifa(code) {
    var t = FIFA[code];
    return t ? { code: code, name: t.name, iso: t.iso } : { code: code, name: code, iso: null };
  }

  // Resolve a football-data team object (tla/name/crest) into a render-ready team.
  // Flag preference: our round circle-flag (by ISO) -> API crest -> initials fallback.
  function resolveTeam(apiTeam) {
    if (!apiTeam || !apiTeam.tla) return null;
    var code = apiTeam.tla;
    var ref = FIFA[code];
    var iso = ref ? ref.iso : null;
    return {
      code: code,
      name: apiTeam.name || (ref ? ref.name : code),
      iso: iso,
      crest: apiTeam.crest || null,
      flag: iso ? flagUrl(iso) : (apiTeam.crest || null)
    };
  }

  var api = {
    FIFA: FIFA, PLACEHOLDER: PLACEHOLDER, flagUrl: flagUrl,
    teamByFifa: teamByFifa, resolveTeam: resolveTeam
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.TeamData = api;
})(typeof window !== 'undefined' ? window : globalThis);
