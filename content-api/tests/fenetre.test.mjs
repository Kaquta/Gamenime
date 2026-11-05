// Les verifications de la regle des sorties de GameNime : la fenetre de 3 ans (decision de Rey du 5 novembre 2026)
// et ce qui est « sorti » ou « a venir » (src/gamenime/core.ts : getReleaseWindow, debutAVenir, estSorti, estAVenir).
//
// Elles tournent a chaque construction de l'API (Dockerfile : RUN node --test ...), sur le code compile
// (dist/gamenime/core.js) : si l'une echoue, la construction s'arrete, l'image d'avant reste et l'API en service ne
// change pas. Les dates sont fixes : elles disent des aujourd'hui ce que la regle donnera le 1er janvier 2027, en
// 2028 ou en 2030, sans attendre.
//
// Changer la regle expres (4 ans, une autre annee de depart...) : changer core.ts ET ces verifications, dans le meme
// patch. Une regle changee par erreur, elle, arrete la construction.
// A la main : cd content-api && npm run build && node --test tests/fenetre.test.mjs
// (patch d'entretien, novembre 2026)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PREMIERE_ANNEE, getReleaseWindow, debutAVenir, estSorti, estAVenir } from "../dist/gamenime/core.js";
import { DB_DATE_RANGE_YEARS } from "../dist/gamenime/constants.js";

const le = (iso) => new Date(iso.length === 10 ? iso + "T12:00:00Z" : iso);
const ext = (...dates) => JSON.stringify(dates.map((d, i) => ({ name: "Extension " + (i + 1), releaseDate: d })));
const sorti = (date, precision, quand, dlcs = null) => estSorti(date, precision, dlcs, le(quand));
const aVenir = (date, precision, quand, dlcs = null) => estAVenir(date, precision, dlcs, le(quand));
const jour = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const jours = (debut, fin) => {
  const l = [];
  for (let d = debut; d <= fin; d = jour(d, 1)) l.push(d);
  return l;
};
// des moments choisis : aujourd'hui, la nuit du Nouvel An, 2027, 2028, 2030
const MOMENTS = ["2026-11-05T12:00:00Z", "2026-12-31T23:59:59Z", "2027-01-01T00:00:00Z", "2027-06-15T12:00:00Z",
  "2028-01-10T12:00:00Z", "2030-06-15T12:00:00Z"];

describe("la fenetre des sortis (getReleaseWindow)", () => {
  it("premiere annee du catalogue : 2026", () => assert.equal(PREMIERE_ANNEE, 2026));
  for (const [quand, debut, fin] of [
    ["2026-11-05T12:00:00Z", "2026-01-01", "2027-12-31"],
    ["2026-12-31T23:59:59Z", "2026-01-01", "2027-12-31"],
    ["2027-01-01T00:00:00Z", "2026-01-01", "2028-12-31"],
    ["2027-12-31T23:59:59Z", "2026-01-01", "2028-12-31"],
    ["2028-01-01T00:00:00Z", "2027-01-01", "2029-12-31"],
    ["2030-06-15T12:00:00Z", "2029-01-01", "2031-12-31"],
  ]) {
    it(`le ${quand.slice(0, 10)} : du ${debut} au ${fin}`, () => assert.deepEqual(getReleaseWindow(new Date(quand)), { start: debut, end: fin }));
  }
  it("heure UTC : le 1er janvier 2027 a 0 h 30 a Paris (23 h 30 UTC la veille), encore la fenetre de 2026", () => {
    assert.deepEqual(getReleaseWindow(new Date("2027-01-01T00:30:00+01:00")), { start: "2026-01-01", end: "2027-12-31" });
  });
  it("chaque mois de 2026 a 2040 : du 1er janvier de l'annee d'avant (jamais avant 2026) au 31 decembre de la suivante", () => {
    for (let a = 2026; a <= 2040; a++) {
      for (let m = 0; m < 12; m++) {
        const w = getReleaseWindow(new Date(Date.UTC(a, m, 15, 12)));
        assert.deepEqual(w, { start: `${Math.max(a - 1, 2026)}-01-01`, end: `${a + 1}-12-31` }, `${a}-${m + 1}`);
      }
    }
  });
});

describe("le debut de A venir pour une date au mois ou a l'annee (debutAVenir)", () => {
  for (const [quand, debut] of [["2026-11-05T12:00:00Z", "2026-01-01"], ["2027-01-01T00:00:00Z", "2027-01-01"], ["2028-06-15T12:00:00Z", "2028-01-01"]]) {
    it(`le ${quand.slice(0, 10)} : depuis le ${debut}`, () => assert.equal(debutAVenir(new Date(quand)), debut));
  }
});

describe("sorti (estSorti)", () => {
  const cas = [
    // [ce qui est verifie, date, precision, le, extensions, attendu]
    ["sorti cette annee", "2026-01-10", "day", "2026-11-05", null, true],
    ["sorti aujourd'hui", "2026-11-05", "day", "2026-11-05", null, true],
    ["demain : pas encore sorti", "2026-11-06", "day", "2026-11-05", null, false],
    ["avant 2026 : jamais dans les sortis", "2025-12-31", "day", "2026-11-05", null, false],
    ["date au mois : jamais sorti (jour inconnu)", "2026-11-01", "month", "2026-11-05", null, false],
    ["date a l'annee : jamais sorti (jour inconnu)", "2026-01-01", "year", "2026-11-05", null, false],
    ["sans date : jamais sorti", null, "day", "2026-11-05", null, false],
    ["date vide : jamais sorti", "", "day", "2026-11-05", null, false],
    ["vieux jeu, extension sortie dans la fenetre : sorti", "2025-06-01", "day", "2026-11-05", ext("2026-09-01"), true],
    ["vieux jeu, extension pas encore sortie : pas sorti", "2025-06-01", "day", "2026-11-05", ext("2026-12-01"), false],
    ["vieux jeu, extension sortie avant la fenetre : pas sorti", "2025-06-01", "day", "2026-11-05", ext("2025-09-01"), false],
    ["vieux jeu, extensions illisibles : pas sorti", "2025-06-01", "day", "2026-11-05", "pas du json", false],
    ["vieux jeu, extension sortie aujourd'hui : sorti", "2025-06-01", "day", "2026-11-05", ext("2026-11-05"), true],
    ["vieux jeu, extension sortie le 1er janvier 2026 : sorti", "2025-06-01", "day", "2026-11-05", ext("2026-01-01"), true],
    ["1er janvier 2027 : 2026 reste dans les sortis", "2026-03-03", "day", "2027-01-01T00:00:00Z", null, true],
    ["1er janvier 2027 : le 31 decembre 2026 aussi", "2026-12-31", "day", "2027-01-01T00:00:00Z", null, true],
    ["1er janvier 2027 : sorti le jour meme", "2027-01-01", "day", "2027-01-01T00:00:00Z", null, true],
    ["en 2027 : toujours rien avant 2026", "2025-12-31", "day", "2027-06-15", null, false],
    ["en 2028 : 2026 quitte les sortis", "2026-12-31", "day", "2028-01-10", null, false],
    ["en 2028 : 2027 reste", "2027-01-01", "day", "2028-01-10", null, true],
    ["en 2028 : vieux jeu, extension sortie en 2027", "2024-01-01", "day", "2028-01-10", ext("2027-03-01"), true],
  ];
  for (const [nom, date, precision, quand, dlcs, attendu] of cas) {
    it(nom, () => assert.equal(sorti(date, precision, quand, dlcs), attendu));
  }
});

describe("a venir (estAVenir)", () => {
  const cas = [
    ["dans six semaines", "2026-12-20", "day", "2026-11-05", null, true],
    ["fin de la fenetre : 31 decembre 2027", "2027-12-31", "day", "2026-11-05", null, true],
    ["apres la fenetre : pas encore dans A venir", "2028-01-01", "day", "2026-11-05", null, false],
    ["aujourd'hui : sorti, pas a venir", "2026-11-05", "day", "2026-11-05", null, false],
    ["prevu en novembre 2026 (date au mois)", "2026-11-01", "month", "2026-11-05", null, true],
    ["prevu courant 2026 (date a l'annee)", "2026-01-01", "year", "2026-11-05", null, true],
    ["prevu en decembre 2027", "2027-12-01", "month", "2026-11-05", null, true],
    ["vieux jeu, extension a venir : a venir", "2024-01-01", "day", "2026-11-05", ext("2027-03-01"), true],
    ["vieux jeu, extension le 31 decembre 2027 : a venir", "2024-01-01", "day", "2026-11-05", ext("2027-12-31"), true],
    ["jeu de la fenetre deja sorti : son extension ne le rend pas a venir", "2026-03-03", "day", "2026-11-05", ext("2027-03-01"), false],
    ["en 2027 : un courant 2026 jamais date au jour pres ne reste pas a venir", "2026-01-01", "year", "2027-01-01T00:00:00Z", null, false],
    ["en 2027 : un prevu decembre 2026 non plus", "2026-12-01", "month", "2027-01-01T00:00:00Z", null, false],
    ["en 2027 : prevu courant 2027", "2027-01-01", "year", "2027-01-01T00:00:00Z", null, true],
    ["en 2027 : jusqu'au 31 decembre 2028", "2028-12-31", "day", "2027-01-01T00:00:00Z", null, true],
    ["en 2027 : pas 2029", "2029-01-01", "day", "2027-01-01T00:00:00Z", null, false],
    ["en 2028 : prevu en decembre 2029", "2029-12-01", "month", "2028-01-10", null, true],
    ["en 2028 : pas 2030", "2030-01-01", "year", "2028-01-10", null, false],
  ];
  for (const [nom, date, precision, quand, dlcs, attendu] of cas) {
    it(nom, () => assert.equal(aVenir(date, precision, quand, dlcs), attendu));
  }
});

describe("garde-fous, a chaque moment choisi et pour chaque jour autour de la fenetre", () => {
  it("sans extension, jamais sorti et a venir a la fois", () => {
    for (const quand of MOMENTS) {
      const { start, end } = getReleaseWindow(le(quand));
      for (const d of jours(jour(start, -40), jour(end, 40))) {
        for (const p of ["day", "month", "year"]) {
          assert.ok(!(sorti(d, p, quand) && aVenir(d, p, quand)), `${d} (${p}) le ${quand}`);
        }
      }
    }
  });
  it("une date au jour pres dans la fenetre est toujours sortie ou a venir (aucun trou)", () => {
    for (const quand of MOMENTS) {
      const { start, end } = getReleaseWindow(le(quand));
      for (const d of jours(start, end)) assert.ok(sorti(d, "day", quand) || aVenir(d, "day", quand), `${d} le ${quand}`);
    }
  });
  it("hors de la fenetre, sans extension : ni sorti ni a venir", () => {
    for (const quand of MOMENTS) {
      const { start, end } = getReleaseWindow(le(quand));
      for (const d of [...jours(jour(start, -40), jour(start, -1)), ...jours(jour(end, 1), jour(end, 40))]) {
        for (const p of ["day", "month", "year"]) {
          assert.ok(!sorti(d, p, quand) && !aVenir(d, p, quand), `${d} (${p}) le ${quand}`);
        }
      }
    }
  });
  it("la base est lue assez large pour la fenetre (DB_DATE_RANGE_YEARS de constants.ts, routes.ts buildWideDateFilter)", () => {
    for (const quand of MOMENTS) {
      const a = le(quand).getUTCFullYear();
      const { start, end } = getReleaseWindow(le(quand));
      assert.ok(`${a - DB_DATE_RANGE_YEARS}-01-01` <= start && `${a + DB_DATE_RANGE_YEARS}-12-31` >= end, `${quand} : ${DB_DATE_RANGE_YEARS} an(s)`);
    }
  });
});
