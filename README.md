# 🫖 T-Pot — SIM-T Ticket Notifier

**Created by [clintzula](https://github.com/clintzula) (Luci DaProphet)**

A Tampermonkey userscript that monitors your SIM-T ticket queue and automatically alerts you when new tickets appear — so you never have to manually refresh and scan the list.

---

## ✨ Features

| Feature | Description |
|---|---|
| 🔔 **Desktop Notifications** | Browser push notifications — works even when the tab isn't focused |
| 🫖 **In-Page Popup** | Slide-in toast with clickable links to each new ticket |
| 🔊 **Sound Alerts** | 5 sounds to choose from: Tea Kettle, Classic Chime, Desk Bell, Digital Ping, Urgent Alarm |
| 🔄 **Auto-Refresh** | Automatically reloads the page on a timer (default: 2 min) |
| 🎯 **Filters** | Notify only for specific assignees, severities, or keywords |
| 🔄 **Assignee Change Detection** | Alerts when a watched assignee is added to an existing ticket |
| ⚙️ **Settings GUI** | Full settings panel with toggles, sliders, and inputs — no code editing needed |
| 📱 **Compact Badge** | Optional minimal badge showing just the icon and countdown |
| 🔗 **Per-View Storage** | Each SIM-T filter/view has its own baseline — switching views won't trigger false alerts |
| 🔄 **Auto-Update** | Tampermonkey automatically checks for new versions from GitHub |

---

## 📥 Installation

### Prerequisites
- [Tampermonkey](https://www.tampermonkey.net/) browser extension installed

### Install T-Pot
1. Click this link: **[Install T-Pot](https://raw.githubusercontent.com/clintzula/t-pot/main/t-pot.user.js)**
2. Tampermonkey will prompt you to install the script — click **Install**
3. Navigate to your SIM-T ticket list (`t.corp.amazon.com/issues/...`)
4. The 🫖 badge should appear in the bottom-right corner
5. **Allow notifications** when prompted by the browser

That's it — T-Pot is now monitoring your queue!

---

## 🎮 How to Use

### The Badge
The T-Pot badge appears in the bottom-right corner of every SIM-T `/issues` page.

| Badge State | What it means |
|---|---|
| `🫖 T-Pot: ON (1:45)` | Auto-refresh active, 1:45 until next refresh |
| `⏸️ T-Pot: OFF` | Auto-refresh paused |
| `📄 T-Pot: PAUSED (non-list page)` | You're on an individual ticket or excluded page |

**Click the badge** to toggle auto-refresh on/off.

### Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| **Alt+R** | Toggle auto-refresh on/off |
| **Alt+S** | Open settings panel |

### Tampermonkey Menu
Right-click the Tampermonkey icon → **🫖 T-Pot Settings** to open settings from anywhere.

---

## ⚙️ Settings

Open settings by clicking the **⚙️ gear icon** on the badge, pressing **Alt+S**, or via the Tampermonkey menu.

### 🔔 Notifications

| Setting | Default | Description |
|---|---|---|
| **Desktop Notifications** | ✅ On | Browser push notifications (work even when tab isn't focused) |
| **In-Page Popup** | ✅ On | Slide-in popup on the page with clickable ticket links |
| **Sound Alert** | ✅ On | Play a sound when new tickets are detected |
| **Notification Sound** | 🫖 Tea Kettle | Choose from 5 sounds (see below) |
| **Volume** | 60% | Adjustable 0–100% with live preview |
| **Notification Duration** | 8 seconds | How long notifications stay visible (1–30 sec) |

#### Available Sounds

| Sound | Description |
|---|---|
| 🫖 **Tea Kettle** (default) | Realistic rising steam whistle with vibrato and hiss |
| 🔔 **Classic Chime** | Clean two-tone sine wave |
| 🛎️ **Desk Bell** | Single resonant ding with harmonics |
| 📱 **Digital Ping** | Short modern double-ping |
| 🚨 **Urgent Alarm** | Triple pulse — hard to miss |

Use the **Test 🔊** button to preview any sound before saving. The test also shows a sample desktop notification and in-page popup so you can see exactly how they look.

### 🎯 Filters

Filters let you control which tickets trigger notifications. Leave a field blank to skip that filter.

| Setting | Example | Description |
|---|---|---|
| **Detect Assignee(s) ONLY** | Toggle | When ON, **only** the assignee filter is used — all other filters are ignored |
| **Assignee(s)** | `alexyano, mdanju` | Only notify for tickets with these assignees (as shown on page) |
| **Severity** | `1, 2, 3` | Only notify for these severity numbers (as shown on page) |
| **Keywords / Ticket Type** | `Boost, Vetting` | Only notify when the ticket row contains these keywords |

#### How Filters Work

**Normal mode** (Detect Assignee(s) ONLY = OFF):
- All non-empty filters are combined with **AND** logic
- Within a filter, multiple values use **OR** logic
- Example: Assignee = `alexyano, mdanju` AND Severity = `1, 2` → only notifies for sev 1 or 2 tickets assigned to alexyano or mdanju

**Assignee-only mode** (Detect Assignee(s) ONLY = ON):
- **Only** the assignee filter is active
- Severity, keywords, and ticket type filters are completely ignored
- Notifies for:
  - 🆕 **New tickets** where the assignee matches your filter
  - 🔄 **Existing tickets** that get reassigned to a watched assignee

### 🔄 Auto-Refresh

| Setting | Default | Description |
|---|---|---|
| **Auto-Refresh** | ✅ On | Reload the page periodically to check for new tickets |
| **Refresh Interval** | 2 minutes | How often to refresh (1–60 min) |

Auto-refresh is smart about where it runs:

| Page | Auto-refresh? |
|---|---|
| `/issues` (ticket list) | ✅ Yes |
| `/issues/all-my-groups` | ✅ Yes |
| `/issues/assigned-to-me` | ✅ Yes |
| `/issues/V2349367928` (individual ticket) | ⏸️ Paused |
| `/issues` with `/create`, `/edit`, `/bulk` in URL | ⏸️ Paused |

The timer **pauses while settings are open** and resumes when you close them.

### 🎨 Appearance

| Setting | Default | Description |
|---|---|---|
| **Compact Badge** | Off | Hide the label text — only show the 🫖 icon, countdown timer, and ⚙️ gear |

### 🔧 Advanced

| Setting | Default | Description |
|---|---|---|
| **Scrape Delay** | 10000 ms | How long to wait for SIM-T to render before reading tickets |
| **Ticket Row Selector** | `tbody tr[data-selection-item="item"]` | CSS selector for ticket rows (change if SIM-T updates its markup) |
| **Ticket ID Attribute** | `data-ticket-id` | Data attribute for ticket IDs |
| **Auto-Refresh Excluded URL Patterns** | `/create, /edit, /bulk` | URL patterns where auto-refresh is paused (comma-separated) |

---

## 🔔 Notification Types

T-Pot shows clear, labeled notifications so you know exactly **why** you're being alerted.

### New Ticket
- 🆕 Icon
- Green **NEW TICKET** badge
- Desktop notification: `🆕 V2349367928 (new ticket)`

### Reassigned Ticket
- 🔄 Icon
- Blue **REASSIGNED → username** badge
- Desktop notification: `🔄 P500063113 → assigned to lucclint`

### Combined
When both new and reassigned tickets are detected:
- Desktop title: `🫖 2 New + 1 Reassigned — T-Pot`
- Popup header: `🫖 2 New + 1 Reassigned`
- Each ticket listed with its own icon and badge

---

## 🔗 Per-View Storage

T-Pot tracks tickets **independently per SIM-T view**. Each unique filter/URL gets its own baseline:

| View | Storage Key |
|---|---|
| `issues?q={...groupA...}` | Separate baseline |
| `issues?q={...groupB...}` | Separate baseline |
| `issues/all-my-groups` | Separate baseline |

This means:
- ✅ Switching between views does **not** trigger false notifications
- ✅ Each view remembers its own "last known" ticket list
- ✅ First visit to any new view stores tickets silently (no alarm)
- ✅ Old views are auto-pruned after 20 to save storage space

---

## 🛠️ Troubleshooting

### No tickets found / Selectors need updating
Open DevTools Console (F12) and look for `[T-Pot]` messages:
- `No tickets found after all retries` → The CSS selector may not match SIM-T's current markup. Check the **Ticket Row Selector** in Advanced settings.
- `Found X tickets on attempt N` → Working! Just took multiple retries.

### Notifications not appearing
1. Make sure your browser allows notifications for `t.corp.amazon.com`
2. Check that **Desktop Notifications** and/or **In-Page Popup** are enabled in settings
3. Sound may be blocked until you click on the page once (browser autoplay policy)

### Sound not playing
Browsers block autoplay audio until you interact with the page. Click anywhere on the SIM-T page once, and sound will work on subsequent notifications.

### Corrupted settings
If settings get corrupted (e.g. the selector breaks), open the DevTools Console and run:
```js
GM_setValue("simt_notifier_settings", "{}");
```
Then refresh — all settings will reset to defaults.

### Clear all ticket data
To start fresh with a clean baseline:
```js
GM_setValue("simt_tickets_by_view", "{}");
```
Then refresh — T-Pot will re-scan and store the current tickets silently.

---

## 🔄 Updates

T-Pot auto-updates via Tampermonkey. When a new version is pushed to GitHub, Tampermonkey will detect the higher `@version` number and prompt you to update.

**To force an update check:**
Tampermonkey icon → Dashboard → Check for updates (refresh icon)

**Install/share link:**
```
https://raw.githubusercontent.com/clintzula/t-pot/main/t-pot.user.js
```

---

## 📋 Changelog

| Version | Date | Changes |
|---|---|---|
| **v2.29** | 2026-09-02 | URL-keyed storage — per-view baselines, no false notifications on view switch |
| **v2.19** | 2026-09-01 | Assignee-only mode strictly disables all other filters |
| **v2.17** | 2026-09-01 | 5 notification sounds, Tea Kettle default at 60% volume |
| **v2.15** | 2026-09-01 | Rich notifications with reason badges, P-prefix ID support, debug logging |
| **v2.14** | 2026-09-01 | Compact badge mode, left-side settings panel |
| **v2.13** | 2026-09-01 | Assignee change detection, centered settings popup |
| **v2.12** | 2026-09-01 | Fixed SIM-T CSS selectors, updated filter descriptions |
| **v2.1** | 2026-09-01 | Overlay fix, timer pause in settings, separate notification toggles |
| **v2.0** | 2026-09-01 | Initial full release — notifications, auto-refresh, filters, settings GUI |

---

## 📜 License

Created by **clintzula (Luci DaProphet)** — free to use and share within Amazon.

🫖 *Your tickets, your way.*
