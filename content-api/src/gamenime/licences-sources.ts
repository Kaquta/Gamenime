/**
 * licences-sources.ts — Les lectures du module des licences (licences.ts) : AniList, IGDB et Wikidata.
 *
 * Plan validé par Rey le 22 octobre 2026 (licences-module-plan.md, § 6) :
 *  - AniList : le limiteur commun de l'API (tourAniList, dates-animes.ts : 2,1 s entre deux requêtes de la Phase B,
 *    du contrôle J-7 et des dates, et la même suspension après un 429), plus 4 s au moins entre deux requêtes de ce
 *    module ; rien de h:54 à h:05 (n8n interroge AniList de h:56 à h:04) ; un plafond de requêtes ; arrêt immédiat si
 *    AniList a suspendu son API (403 « temporarily disabled »).
 *  - IGDB : la fonction commune de l'API (igdbFetch, twitch.ts) : le jeton Twitch partagé, aucun nouveau jeton ;
 *    400 ms entre deux requêtes.
 *  - Wikidata : identifiant GameNime, 1,5 s entre deux requêtes, deux nouveaux essais pour un paquet perdu.
 *
 * Deux sortes d'arrêt, et dans les deux cas le passage n'écrit rien :
 *  - PanneSource : une source en panne, qui refuse ou répond mal (ligne du Pilotage en rouge, nouvel essai 6 h plus tard) ;
 *  - Incomplet : le passage ne peut pas finir proprement (temps, plafond de requêtes ; ligne en orange).
 */
import { aniListRefuse, tourAniList } from "./dates-animes.js";
import { igdbFetch } from "./twitch.js";

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
const court = (s: unknown, n = 120): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Une source en panne ou qui refuse : rien n'est écrit (ligne en rouge, nouvel essai 6 h plus tard). */
export class PanneSource extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PanneSource";
  }
}
/** Une requête refusée par la source (erreur GraphQL d'AniList, champ refusé) : une PanneSource, que l'appelant peut
 * traiter à part quand la lecture est facultative (les auteurs de la ligne d'origine). */
export class RefusRequete extends PanneSource {
  constructor(message: string) {
    super(message);
    this.name = "RefusRequete";
  }
}
/** Un passage qui ne peut pas finir proprement (temps, plafond de requêtes) : rien n'est écrit (ligne en orange). */
export class Incomplet extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Incomplet";
  }
}

/** Attente demandée par Retry-After (secondes ou date HTTP), en ms ; null si absente ou illisible. */
export function attenteDemandee(entete: string | null | undefined, maintenant = Date.now()): number | null {
  if (entete == null || !String(entete).trim()) return null;
  const s = Number(entete);
  if (Number.isFinite(s)) return Math.max(0, s) * 1000;
  const t = Date.parse(String(entete));
  return Number.isFinite(t) ? Math.max(0, t - maintenant) : null;
}

/** La fin du passage : passé cette heure, plus aucune requête. */
abstract class Source {
  n = 0;
  protected dernier = 0;
  constructor(protected nom: string, protected fin: number, protected pauseMs: number, protected attenteMs: number) {}
  protected verifierTemps(): void {
    if (Date.now() > this.fin) throw new Incomplet(`${this.nom} : temps du passage écoulé`);
  }
  /** Attend ms, sauf si l'attente dépasse la fin du passage. */
  protected async attendre(ms: number): Promise<void> {
    if (Date.now() + ms > this.fin) throw new Incomplet(`${this.nom} : temps du passage écoulé (attente de ${Math.ceil(ms / 1000)} s)`);
    await dormir(ms);
  }
  /** La pause entre deux requêtes de la source. */
  protected async pause(): Promise<void> {
    const reste = this.dernier + this.pauseMs - Date.now();
    if (this.dernier && reste > 0) await this.attendre(reste);
  }
}

// ─────────────────────────────────────────────────────────────── AniList

export interface OptionsAniList {
  url: string;
  pauseMs: number;
  /** Pause de h:54 à h:05 pour laisser passer n8n. */
  n8n: boolean;
  maxRequetes: number;
  fin: number;
  /** Attente après une panne réseau ou une erreur du serveur (essais : plus court). */
  attenteMs?: number;
  /** Essais seulement : décale l'horloge de la pause n8n (minutes) et raccourcit la pause. */
  decalageN8nMin?: number;
  echelleN8n?: number;
  dire?: (ligne: string) => void;
}

export interface ReponseAniList {
  status: number;
  data: any;
  errors: any[];
}

export class AniList extends Source {
  pauses = 0;
  private libreJusqua = 0;
  constructor(private o: OptionsAniList) {
    super("AniList", o.fin, o.pauseMs, o.attenteMs ?? 15000);
  }

  /** Sommes-nous dans la fenêtre de n8n (h:54 à h:05) ? */
  private dansCreneauN8n(): boolean {
    if (!this.o.n8n) return false;
    const m = new Date(Date.now() + (this.o.decalageN8nMin ?? 0) * 60000).getUTCMinutes();
    return !(m >= 5 && m < 54);
  }

  /** Rien vers AniList de h:54 à h:05 : attend h:05 (plus 5 s), sauf si l'attente dépasse la fin du passage. */
  private async creneauN8n(): Promise<void> {
    if (!this.o.n8n || Date.now() < this.libreJusqua) return;
    const h = new Date(Date.now() + (this.o.decalageN8nMin ?? 0) * 60000);
    const m = h.getUTCMinutes(), s = h.getUTCSeconds();
    if (m >= 5 && m < 54) return;
    const reste = Math.max(0, ((m >= 54 ? 65 - m : 5 - m) * 60 - s + 5) * 1000) * (this.o.echelleN8n ?? 1);
    if (Date.now() + reste > this.fin) throw new Incomplet("AniList : la pause pour n8n dépasserait le temps du passage");
    this.pauses++;
    this.o.dire?.(`  pause d'AniList jusqu'à h:05 (n8n interroge AniList entre h:56 et h:04), environ ${Math.ceil(reste / 60000)} min`);
    await dormir(reste);
    // après la pause, la fenêtre de n8n est loin : pas de nouvelle lecture de l'horloge avant 48 min
    this.libreJusqua = Date.now() + 48 * 60000;
  }

  /** Une requête GraphQL. Réessayée sur une panne réseau, une erreur du serveur ou un 429 ; 403 « suspendu » : arrêt. */
  async requete(query: string, variables?: Record<string, unknown>): Promise<ReponseAniList> {
    let reseau = 0, serveur = 0, refus = 0;
    for (;;) {
      if (this.n >= this.o.maxRequetes) throw new Incomplet(`AniList : plafond de ${this.o.maxRequetes} requêtes atteint`);
      this.verifierTemps();
      await this.creneauN8n();
      await this.pause();
      await this.creneauN8n();
      await tourAniList();
      // l'attente du limiteur commun (suspension après un 429) a pu mener dans la fenêtre de n8n : on la revoit
      if (Date.now() >= this.libreJusqua && this.dansCreneauN8n()) {
        this.libreJusqua = 0;
        continue;
      }
      this.verifierTemps();
      this.n++;
      this.dernier = Date.now();
      let r: Response;
      try {
        r = await fetch(this.o.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(variables ? { query, variables } : { query }),
          signal: AbortSignal.timeout(60000),
        });
      } catch {
        if (++reseau < 3) {
          await this.attendre(this.attenteMs);
          continue;
        }
        throw new PanneSource("AniList injoignable");
      }
      if (r.status === 429) {
        const ms = aniListRefuse(r.headers.get("retry-after"));
        await r.body?.cancel().catch(() => {});
        if (++refus > 3) throw new PanneSource("AniList : trop de requêtes (429 répétés)");
        if (Date.now() + ms > this.fin) throw new Incomplet("AniList : attente demandée au-delà du temps du passage");
        continue; // tourAniList attend la fin de la suspension
      }
      const texte = await r.text().catch(() => "");
      let d: any = null;
      try {
        d = JSON.parse(texte);
      } catch {
        d = null;
      }
      if (r.status === 403) {
        const m = String(d?.errors?.[0]?.message ?? texte);
        throw new PanneSource(/disabled|suspend/i.test(m) ? "AniList : API suspendue par AniList (panne de leur côté)" : "AniList : HTTP 403");
      }
      if (r.status >= 500 || !d || typeof d !== "object") {
        if (++serveur < 3) {
          await this.attendre(this.attenteMs);
          continue;
        }
        throw new PanneSource(r.status >= 500 ? `AniList : HTTP ${r.status}` : `AniList : réponse illisible (HTTP ${r.status})`);
      }
      return { status: r.status, data: d.data ?? null, errors: Array.isArray(d.errors) ? d.errors : [] };
    }
  }

  /** AniList répond-il ? Une suspension (403) arrête tout de suite (PanneSource). */
  async sonde(): Promise<void> {
    const r = await this.requete("query { Media(id: 1, type: ANIME) { id } }");
    if (r.status >= 400 && !r.data) throw new PanneSource(`AniList : HTTP ${r.status}${r.errors[0]?.message ? ` (${court(r.errors[0].message, 80)})` : ""}`);
  }

  /**
   * Des animés par lots d'identifiants (requête à $ids et $n). Un lot jugé trop complexe est coupé en deux ; une autre
   * erreur arrête la lecture (PanneSource) : un passage qui a perdu un lot n'écrit rien.
   */
  async parLots(requete: string, ids: number[], taille0 = 50): Promise<any[]> {
    const res: any[] = [];
    let taille = taille0;
    for (let i = 0; i < ids.length; ) {
      const paquet = ids.slice(i, i + taille);
      const r = await this.requete(requete, { ids: paquet, n: paquet.length });
      const media = r.data?.Page?.media;
      const m = String(r.errors[0]?.message ?? "");
      if (r.errors.length && /complex/i.test(m) && taille > 5) {
        taille = Math.max(5, Math.ceil(taille / 2));
        continue;
      }
      if (r.errors.length || !Array.isArray(media)) throw new RefusRequete(`AniList : ${m ? court(m, 100) : "HTTP " + r.status}`);
      for (const x of media) if (x && Number(x.id) > 0) res.push(x);
      i += paquet.length;
    }
    return res;
  }

  /** Recherche par nom, plusieurs noms par requête : nom -> animés (5 au plus). */
  async chercher(noms: string[], champs: string): Promise<Map<string, any[]>> {
    const res = new Map<string, any[]>();
    let taille = 8;
    for (let i = 0; i < noms.length; ) {
      const paquet = noms.slice(i, i + taille);
      const q = "query { " + paquet.map((n, k) => `a${k}: Page(page: 1, perPage: 5) { media(search: ${JSON.stringify(n)}, type: ANIME, sort: SEARCH_MATCH) { ${champs} } }`).join(" ") + " }";
      const r = await this.requete(q);
      const m = String(r.errors[0]?.message ?? "");
      if (r.errors.length && /complex/i.test(m) && taille > 1) {
        taille = Math.max(1, Math.floor(taille / 2));
        continue;
      }
      if (r.errors.length || !r.data) throw new RefusRequete(`AniList (recherche) : ${m ? court(m, 100) : "HTTP " + r.status}`);
      paquet.forEach((n, k) => {
        const l = r.data[`a${k}`]?.media;
        res.set(n, Array.isArray(l) ? l.filter((x: any) => x && Number(x.id) > 0) : []);
      });
      i += paquet.length;
    }
    return res;
  }
}

// ─────────────────────────────────────────────────────────────── IGDB

export interface OptionsIgdb {
  base: string;
  pauseMs: number;
  maxRequetes: number;
  fin: number;
  attenteMs?: number;
  /** L'appel HTTP : igdbFetch (jeton Twitch partagé) ; les essais en donnent un autre. */
  appel?: (url: string, init: RequestInit) => Promise<Response>;
}

export class Igdb extends Source {
  constructor(private o: OptionsIgdb) {
    super("IGDB", o.fin, o.pauseMs, o.attenteMs ?? 5000);
  }

  /** Une requête APIcalypse (point d'accès, corps). Réessayée sur une panne réseau, un 429 ou une erreur du serveur. */
  async requete(point: string, corps: string): Promise<{ status: number; texte: string }> {
    let essais = 0;
    for (;;) {
      if (this.n >= this.o.maxRequetes) throw new Incomplet(`IGDB : plafond de ${this.o.maxRequetes} requêtes atteint`);
      this.verifierTemps();
      await this.pause();
      this.n++;
      this.dernier = Date.now();
      let r: Response;
      try {
        r = await (this.o.appel ?? igdbFetch)(`${this.o.base}/${point}`, {
          method: "POST",
          headers: { "Content-Type": "text/plain", Accept: "application/json" },
          body: corps,
        });
      } catch {
        if (++essais < 3) {
          await this.attendre(this.attenteMs);
          continue;
        }
        throw new PanneSource("IGDB injoignable");
      }
      if (r.status === 429 || r.status >= 500) {
        const ms = r.status === 429 ? attenteDemandee(r.headers.get("retry-after")) ?? 2000 : this.attenteMs;
        await r.body?.cancel().catch(() => {});
        if (++essais < 3) {
          await this.attendre(Math.min(ms, 60000));
          continue;
        }
        throw new PanneSource(`IGDB : HTTP ${r.status}`);
      }
      if (r.status === 401 || r.status === 403) {
        await r.body?.cancel().catch(() => {});
        throw new PanneSource(`IGDB : HTTP ${r.status} (jeton Twitch refusé)`);
      }
      // un corps coupé ou illisible compte comme une panne réseau : nouvel essai, puis arrêt (jamais lu comme un refus)
      let texte: string | null = null;
      try {
        texte = await r.text();
        if (r.status === 200) JSON.parse(texte);
      } catch {
        texte = null;
      }
      if (texte == null) {
        if (++essais < 3) {
          await this.attendre(this.attenteMs);
          continue;
        }
        throw new PanneSource(`IGDB : réponse illisible (HTTP ${r.status})`);
      }
      return { status: r.status, texte };
    }
  }
}

// ─────────────────────────────────────────────────────────────── Wikidata

export interface OptionsWikidata {
  url: string;
  pauseMs: number;
  fin: number;
  agent: string;
  attenteMs?: number;
}

export class Wikidata extends Source {
  constructor(private o: OptionsWikidata) {
    super("Wikidata", o.fin, o.pauseMs, o.attenteMs ?? 10000);
  }

  /** Une requête SPARQL ; deux nouveaux essais sur une panne réseau, un 429 ou une erreur du serveur. */
  async sparql(requete: string): Promise<any[]> {
    let essais = 0;
    for (;;) {
      this.verifierTemps();
      await this.pause();
      this.n++;
      this.dernier = Date.now();
      let r: Response;
      try {
        r = await fetch(this.o.url, {
          method: "POST",
          headers: { "User-Agent": this.o.agent, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/sparql-results+json" },
          body: new URLSearchParams({ query: requete }).toString(),
          signal: AbortSignal.timeout(90000),
        });
      } catch {
        if (++essais < 3) {
          await this.attendre(this.attenteMs);
          continue;
        }
        throw new PanneSource("Wikidata injoignable");
      }
      if (r.status === 429 || r.status >= 500) {
        const ms = r.status === 429 ? attenteDemandee(r.headers.get("retry-after")) ?? this.attenteMs : this.attenteMs * (essais + 1);
        await r.body?.cancel().catch(() => {});
        if (++essais < 3) {
          await this.attendre(Math.min(ms, 60000));
          continue;
        }
        throw new PanneSource(`Wikidata : HTTP ${r.status}`);
      }
      if (!r.ok) {
        await r.body?.cancel().catch(() => {});
        throw new PanneSource(`Wikidata : HTTP ${r.status}`);
      }
      const d: any = await r.json().catch(() => null);
      if (!Array.isArray(d?.results?.bindings)) {
        if (++essais < 3) {
          await this.attendre(this.attenteMs);
          continue;
        }
        throw new PanneSource("Wikidata : réponse illisible");
      }
      return d.results.bindings;
    }
  }
}
