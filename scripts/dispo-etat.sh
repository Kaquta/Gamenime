#!/bin/bash
# GameNime — ce que la presse et Tavily ont trouvé pour la France, et le module plateformes. Lecture seule : rien n'est modifié.
# Usage : bash /opt/stack/scripts/dispo-etat.sh
set -uo pipefail
sql() { docker exec -i mariadb sh -c 'MYSQL_PWD="$MARIADB_PASSWORD" exec mariadb -u"$MARIADB_USER" --default-character-set=utf8mb4 -t "$MARIADB_DATABASE"'; }
echo "── $(TZ=Europe/Paris date '+%d/%m/%Y %H:%M') heure de Paris (comme toutes les heures ci-dessous) · réglages : $(docker exec content-api sh -c 'echo presse=${PRESSE_ENABLED:-?} jours=${PRESSE_JOURS:-3} plateformes=${PLATEFORMES_ENABLED:-?} tavily=${TAVILY_ENABLED:-?}' 2>/dev/null)"
echo "── Presse : articles lus"
sql <<'SQL'
SELECT statut, COUNT(*) AS articles, SUM(lu_le > NOW() - INTERVAL 24 HOUR) AS `dernières 24 h`, DATE_FORMAT(MAX(lu_le), '%d/%m %H:%i') AS `dernier lu` FROM presse_articles GROUP BY statut ORDER BY articles DESC;
SQL
echo "── Annonces France gardées, presse et Tavily (les 25 dernières)"
sql <<'SQL'
SELECT LEFT(COALESCE(a.title_english, a.title, CONCAT('#', n.anime_id)), 38) AS anime, n.plateforme, n.pays, IFNULL(DATE_FORMAT(n.date_dispo, '%d/%m/%Y'), '-') AS date, IFNULL(n.heure, '-') AS heure, n.source, DATE_FORMAT(n.cree_le, '%d/%m %H:%i') AS `lue le`
  FROM annonces_fr n LEFT JOIN anime_items a ON a.id = n.anime_id ORDER BY n.cree_le DESC, n.id DESC LIMIT 25;
SQL
echo "── Tavily : crédits du mois (1 recherche = 1 crédit ; 1 000 gratuits par mois)"
sql <<'SQL'
SELECT COUNT(*) AS recherches, IFNULL(SUM(credits), 0) AS `crédits`, IFNULL(SUM(cherche_le >= CURDATE()), 0) AS `aujourd'hui`, IFNULL(SUM(statut = 'trouve'), 0) AS `trouvés`, IFNULL(SUM(statut = 'a_lire'), 0) AS `en attente d'Ollama`
  FROM tavily_recherches WHERE cherche_le >= DATE_FORMAT(CURDATE(), '%Y-%m-01');
SQL
echo "── Tavily : dernières recherches (15)"
sql <<'SQL'
SELECT LEFT(COALESCE(a.title_english, a.title, CONCAT('#', r.anime_id)), 34) AS anime, r.motif, DATE_FORMAT(r.cherche_le, '%d/%m %H:%i') AS `cherché le`, r.statut, LEFT(IFNULL(r.note, ''), 80) AS note
  FROM tavily_recherches r LEFT JOIN anime_items a ON a.id = r.anime_id ORDER BY r.id DESC LIMIT 15;
SQL
echo "── Journaux de GameNime API (presse, plateformes et Tavily, 10 derniers)"
docker logs content-api 2>&1 | grep -E 'presse :|plateformes :|tavily :' | tail -n 10 | cut -c1-260
