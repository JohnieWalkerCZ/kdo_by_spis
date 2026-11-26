# Kdo by nejspíš…

Hra ve stylu Kahoot na stužkovák. Projektor ukazuje otázku „Kdo by nejspíš…“, odpočet a výsledky, spolužáci hlasují z mobilu.

- **Projektor:** `/host` (chráněno heslem `KDO_HOST_KEY`)
- **Hráči:** `/` → PIN z projektoru (nebo naskenovat QR kód). Hráči jsou anonymní („Anonymní vydra 🦦“).
- Hlas jde měnit až do konce odpočtu. Výsledky ukazují jen počty hlasů, nikdy kdo pro koho hlasoval.
- Stav se průběžně ukládá do `/data/state.json`. Po pádu nebo restartu serveru hra pokračuje a hlasy zůstanou. Dohrané hry se archivují do `/data/games/` a dají se stáhnout na úvodní obrazovce projektoru.

## Otázky a jména

Nejjednodušší je **admin panel** na `/admin` (stejné heslo jako projektor, odkaz je i na úvodní obrazovce projektoru). Tam upravíš hráče (jedno jméno na řádek), otázky (pořadí, vlastní čas) a nastavení. Uložená data jdou do `/data/data.json` ve volume, takže přežijí restart i rebuild. Platí od další nové hry, rozehraná hra jede dál se svými otázkami.

[data.json](data.json) v repu je jen výchozí obsah pro první spuštění, dokud v adminu nic neuložíš:

```json
{
  "people": ["Adam Novák", "Bára Svobodová"],
  "settings": { "defaultTime": 20, "shuffleQuestions": false, "resultsTop": 5, "autoEndWhenAllVoted": false },
  "questions": [
    { "text": "Kdo by nejspíš zaspal na vlastní svatbu?" },
    { "text": "Kdo bude jednou milionář?", "time": 30 }
  ]
}
```

`time` je délka hlasování v sekundách (5–600), jinak platí `defaultTime`. Při chybě (duplicitní jméno, prázdná otázka…) server nenaběhne a vypíše důvod do logu. Rozehraná hra si otázky drží v uloženém stavu, změny se projeví až v nové hře.

## Ovládání projektoru

| Fáze | Akce |
|---|---|
| Lobby | **Spustit hru** |
| Otázka | **Ukončit hlasování**, +10 s, Přeskočit otázku |
| Výsledky | **Další otázka / Finále**, Zopakovat otázku |
| Finále | Stáhnout výsledky, **Zavřít hru** |

Mezerník / → spustí zvýrazněnou akci, `F` = celá obrazovka, `+` = +10 s. Dole jde vypnout zvuk a zapnout automatické ukončení otázky, když hlasují všichni.

## Lokální spuštění

```bash
npm install
npm run build      # client TS -> public/*.js (esbuild); `npm run dev:client` hlídá změny
npm run dev        # KDO_HOST_KEY=dev, http://localhost:3000/host
npm run typecheck  # tsc server + client
npm test
```

Server je TypeScript spouštěný přímo Node 24 (bez buildu), klient se bundluje esbuildem. Sdílené typy zpráv a stavu jsou v [shared/types.ts](shared/types.ts).

Mobil na stejné Wi-Fi otevře `http://<IP počítače>:3000`. Pozor: školní Wi-Fi často zařízení mezi sebou izoluje, takže spolehlivější je nasazení na server.

## Nasazení (Portainer)

Stejně jako ostatní stacky: **Stacks → Add stack → Repository**, Compose path `infra/compose.yaml`. V **Environment variables** nastav proměnné podle [.env.example](.env.example):

| Proměnná | Výchozí | Popis |
|---|---|---|
| `KDO_HOST_KEY` | – (povinné) | heslo pro `/host` |
| `KDO_WEB_PORT` | `6767` | port na hostu |
| `KDO_PUBLIC_URL` | – | veřejná adresa pro QR kód, např. `https://kdoby.example.cz` |
| `KDO_TRUST_PROXY` | `false` | `true` za reverse proxy (rate limit PINu podle `X-Forwarded-For`) |

Data jsou v named volume `kdo-data`. Reverse proxy musí povolit **WebSocket upgrade na `/ws`** a mít read timeout aspoň 60 s (server posílá ping každých 20 s). Otázky jde změnit bez rebuildu: odkomentuj mount `data.json` v compose souboru.

Bez Portaineru:

```bash
KDO_HOST_KEY=tajne docker compose -f infra/compose.yaml up -d --build
```
