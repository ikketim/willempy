# Dutch WOS State Bot 🏔️

Een eenvoudige Discord bot voor de **Dutch Whiteout Survival** community.  
A simple Discord bot for the **Dutch Whiteout Survival** community.

---

## Functies / Features

| Functie | Beschrijving |
|---|---|
| **Welkomst DM** | Vraagt nieuwe leden om hun WOS speler-ID via een DM |
| **Automatische rol toewijzing** | Geeft de bijbehorende staats-rol (bijv. `1042`) op basis van `kid` uit de WOS API |
| **Rol aanmaken** | Maakt automatisch een nieuwe Discord-rol aan als de staat nog niet bestaat; kleur = eerste 6 hex-cijfers van MD5(staat) |
| **Dagelijks vernieuwen** | Controleert alle geregistreerde spelers elke dag om 00:00 UTC en werkt rollen bij bij een staatswijziging |
| **Admin: `/regen-colors`** | Herbereken MD5-kleuren voor alle staatrollen |
| **Admin: `/refresh-data`** | Haal direct spelersdata op en update rollen |

---

## Vereisten / Requirements

- Node.js **18+**
- Een Discord bot token (met `Server Members Intent` en `Message Content Intent` ingeschakeld in de Developer Portal)

---

## Installatie / Setup

```bash
# 1. Clone / download the project
cd willempy

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env and fill in your values

# 4. Start the bot
npm start
```

### `.env` variabelen

| Variabele | Beschrijving |
|---|---|
| `TOKEN` | Discord bot token |
| `ADMIN_ROLE_ID` | (optioneel) Discord rol-ID waarvan leden admin-commando's mogen gebruiken. Laat leeg om alleen server-Administrators toe te staan. |

---

## Discord Developer Portal instellingen

In de [Discord Developer Portal](https://discord.com/developers/applications):

1. Ga naar **Bot**
2. Zet **Server Members Intent** ✅ aan
3. Zet **Message Content Intent** ✅ aan

---

## Hoe werkt de kleur?

De kleur van elke staatrol wordt bepaald door:

```
MD5( String(state) ) → eerste 6 hex tekens → Discord kleur
```

Voorbeeld: staat `1042` → MD5 → `a1b2c3…` → kleur `#a1b2c3`

---

## Database

De bot slaat alle data lokaal op in een SQLite database (`data/bot.db`).  
Geen externe database nodig.

### Tabellen

| Tabel | Inhoud |
|---|---|
| `players` | discord_id, player_id, nickname, state |
| `state_roles` | state → role_id mapping |

---

## Structuur

```
willempy/
├── src/
│   ├── index.js          # Bot entry point + event wiring
│   ├── database.js       # SQLite database (better-sqlite3)
│   ├── wosApi.js         # WOS giftcode API client
│   ├── roleManager.js    # Role creation, assignment, color regen
│   ├── memberJoin.js     # New member DM flow
│   ├── adminCommands.js  # /regen-colors + /refresh-data
│   └── scheduler.js      # Daily 00:00 UTC refresh job
├── data/                 # Created automatically (SQLite DB lives here)
├── .env.example
├── package.json
└── README.md
```
