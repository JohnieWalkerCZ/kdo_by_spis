# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
- **Spolužáci (hráči):** maturitní třída (~20–35 lidí) na vlastním stužkováku, sedí u stolů v zatemněném sále, hlasují z vlastních mobilů (převážně telefony, různé prohlížeče).
- **Moderátor (host):** jeden člověk u počítače připojeného k projektoru; ovládá hru tlačítky nebo mezerníkem, zatímco zbytek sálu kouká na plátno.
- **Publikum v sále:** všichni včetně učitelů a hostů čtou projekci z dálky, i ze zadních stolů.

## Product Purpose
Hra „Kdo by nejspíš…“ ve stylu kvízové show: projektor ukáže otázku a odpočet, každý anonymně tipne jednoho spolužáka, pak se odhalí výsledky. Úspěch = sál se baví, nikdo se nezasekne s připojením, výsledky jsou čitelné z celé místnosti a hlasování je opravdu anonymní.

## Positioning
Není to obecný kvíz: odpovědi jsou jména lidí, kteří sedí ve stejném sále. Napětí vzniká z odhalení, koho třída zvolila, ne ze správných odpovědí nebo bodů.

## Operating Context
- Večerní akce, zatemněný sál, projekce na plátno; mobily v ruce u stolů.
- Hráči se připojí přes QR kód nebo 6místný PIN, dostanou anonymní identitu („Anonymní vydra“).
- Průběh: lobby → otázka s odpočtem → výsledky (top 5 na projektoru, top 3 na mobilu) → … → finále s „Hvězdou večera“.
- Hosting: Docker stack v Portaineru za TLS reverse proxy.

## Capabilities and Constraints
- Čisté HTML + JS + CSS bez build kroku a bez frameworku, servírované malým Node serverem; DOM id používaná v `public/app.js` a `public/host.js` jsou kontrakt.
- Musí fungovat offline od CDN (žádné externí fonty ani skripty; CSP `default-src 'self'`).
- Celé UI v češtině.
- Výsledky jsou jen počty hlasů, nikdy kdo pro koho hlasoval.
- Seznam jmen a otázek z `data.json`; jména v repu jsou zatím vymyšlená.

## Brand Commitments
- Název: „Kdo by nejspíš…“. Bez názvu třídy či roku.
- Vizuální styl podle Manuálu vizuální identity Jarošky (Gymnázium Brno, třída Kapitána Jaroše), který dodal uživatel 2026-11-26: nadpisové písmo Kapitán Medium (jen nadpisy, proklad 110 %, žádná falešná kurzíva/tučnost), chlebové písmo Clear Sans (proklad 120–125 %), barvy #cb1730 červená, černá, #808080 šedá, bílá.
- Uživatel zvolil variantu „Večer na černé“: černá plocha, červená jen pro čas a vítěze.

## Evidence on Hand
- Manuál Jarošky (PDF u uživatele, ne v repu) a písmo Kapitán Medium (`public/fonts/kapitan-medium.woff2`). Logo Jarošky se v aplikaci zatím nepoužívá; fotky ani jinou grafiku třídy nevymýšlet.

## Product Principles
1. Čitelnost z posledního stolu je důležitější než efekt.
2. Mobil je ovladač: jedno ťuknutí = hlas, žádné zbytečné kroky.
3. Anonymita je posvátná; UI nesmí naznačovat, kdo hlasoval jak.
4. Má to působit jako večer pro dospělé maturanty: ne korporátně, ne dětsky.

## Accessibility & Inclusion
- Vysoký kontrast a velké písmo na projekci (sledováno z dálky v šeru).
- Respektovat `prefers-reduced-motion`; dotykové cíle na mobilu ≥ 48 px.
