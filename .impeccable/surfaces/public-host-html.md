---
version: 1
slug: "public-host-html"
primary_target: "public/host.html"
related_targets: ["public/index.html"]
---

# Surface: projektor + mobil hráče

Scope: `public/host.html` (Experience, projekce v zatemněném sále) a `public/index.html` (Operate, mobil jako ovladač). Jeden svět pro obě plochy.

Audience/job: sál čte otázku, odpočet a odhalení z dálky; hráč jedním ťuknutím hlasuje. Constraints: DOM id v app.js/host.js jsou kontrakt, žádné CDN, čeština, anonymita.

## Direction contract

THESIS: Večer na černé — identita Jarošky (manuál) převedená do zatemněného sálu: černá plocha, bílý Kapitán, červená jen pro čas a vítěze. Odmítá kvízovou šablonu s barevnými dlaždicemi i plnou červenou projekci, která v šeru oslní.

OWN-WORLD: Černá #141112, bílý text, šedé #9a9596 popisky v Clear Sans verzálkách, linky #3b3537, červená #cb1730 výhradně pro svislou linku u otázky, odpočet (číslo + dráha) a vítěze. Kapitán Medium jen v nadpisech s prokladem 110 %, Clear Sans text. Žádná zaoblení, žádné stíny, žádné ikony místo textu.

STORY: Lobby: titul, QR, počet v sále a jména zvířátek, obří PIN. Otázka: velký Kapitán s červenou linkou, dole červené číslo a ubíhající dráha, počet hlasů. Výsledky: seznam od nejnižšího, vítěz poslední, větší, s červenou linkou nad sebou. Finále: hvězda večera + přehled vítězů. Mobil: černý seznam jmen, výběr = červený řádek.

FIRST VIEWPORT: Projektor 16:9 otázka: nahoře popisky (otázka n z N, PIN), vlevo velký Kapitán ~6.6em s červenou linkou, dole červené číslo, dráha přes šířku, „x z y hlasovalo“. Mobil: hlavička s popiskem a červeným číslem, otázka s linkou, dráha, hledání, seznam.

FORM: Varianta F „Večer na černé“ z kola náhledů podle manuálu Jarošky; seed: none (pinned) — „Zkus to udělat podle tohoto stylu“ (manuál Jarošky) + volba „F · Večer na černé“.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
