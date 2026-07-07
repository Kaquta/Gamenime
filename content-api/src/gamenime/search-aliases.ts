// ═══════════════════════════════════════════════════════════
// GameNime — Dictionnaire de surnoms/acronymes populaires
// Objectif : "gta" trouve Grand Theft Auto, "jjk" trouve Jujutsu Kaisen.
// Vu la vision (uniquement titres populaires), la liste est limitee et connue.
// Clé = surnom tapé (minuscule), Valeur = fragment cherché dans le titre.
// ═══════════════════════════════════════════════════════════

export const SEARCH_ALIASES: Record<string, string> = {
  // ─── JEUX ───
  "gta": "grand theft auto",
  "gta6": "grand theft auto vi",
  "gta 6": "grand theft auto vi",
  "gtavi": "grand theft auto vi",
  "gta5": "grand theft auto v",
  "cod": "call of duty",
  "bo7": "black ops 7",
  "mw": "modern warfare",
  "ff": "final fantasy",
  "ff7": "final fantasy vii",
  "ffvii": "final fantasy vii",
  "ff16": "final fantasy xvi",
  "ac": "assassin's creed",
  "botw": "breath of the wild",
  "totk": "tears of the kingdom",
  "ds": "death stranding",
  "ds2": "death stranding 2",
  "er": "elden ring",
  "poe": "path of exile",
  "poe2": "path of exile 2",
  "wow": "world of warcraft",
  "lol": "league of legends",
  "cs": "counter-strike",
  "cs2": "counter-strike 2",
  "pubg": "playerunknown",
  "rdr": "red dead redemption",
  "rdr2": "red dead redemption 2",
  "gow": "god of war",
  "tlou": "the last of us",
  "re": "resident evil",
  "re4": "resident evil 4",
  "dmc": "devil may cry",
  "mhw": "monster hunter",
  "sf6": "street fighter 6",
  "mk": "mortal kombat",
  "nier": "nier",
  "kh": "kingdom hearts",
  "kh4": "kingdom hearts iv",
  "p5": "persona 5",
  "smt": "shin megami tensei",
  "dbd": "dead by daylight",
  "hades2": "hades ii",
  "gi": "genshin impact",
  "hsr": "honkai star rail",
  "zzz": "zenless zone zero",

  // ─── ANIME ───
  "jjk": "jujutsu kaisen",
  "aot": "attack on titan",
  "snk": "shingeki no kyojin",
  "mha": "my hero academia",
  "bnha": "boku no hero academia",
  "op": "one piece",
  "ds anime": "demon slayer",
  "kny": "kimetsu no yaiba",
  "dbz": "dragon ball z",
  "db": "dragon ball",
  "dbs": "dragon ball super",
  "hxh": "hunter x hunter",
  "fmab": "fullmetal alchemist brotherhood",
  "fma": "fullmetal alchemist",
  "csm": "chainsaw man",
  "sao": "sword art online",
  "re:zero": "re:zero",
  "rezero": "re:zero",
  "konosuba": "kono subarashii",
  "jojo": "jojo",
  "mob": "mob psycho",
  "tpn": "promised neverland",
  "bsd": "bungo stray dogs",
  "tbhk": "toilet-bound hanako",
  "kaguya": "kaguya-sama",
  "oshi": "oshi no ko",
  "spy": "spy x family",
  "sxf": "spy x family",
  "vs": "vinland saga",
  "frieren": "frieren",
  "bleach tybw": "bleach",
  "black clover": "black clover",
  "bc": "black clover",
  "haikyuu": "haikyuu",
  "bluelock": "blue lock",
  "bllk": "blue lock",
  "dandadan": "dandadan",
};

/**
 * Étend un terme de recherche : si c'est un surnom connu, renvoie AUSSI le titre complet.
 * Renvoie la liste des termes à chercher (le terme original + l'alias éventuel).
 */
export function expandSearchTerm(needle: string): string[] {
  const clean = needle.trim().toLowerCase();
  const terms = [clean];
  const alias = SEARCH_ALIASES[clean];
  if (alias && alias !== clean) {
    terms.push(alias);
  }
  return terms;
}
