// ==UserScript==
// @name         T-Pot — SIM-T Ticket Notifier
// @namespace    http://tampermonkey.net/
// @version      2.32
// @updateURL    https://raw.githubusercontent.com/clintzula/t-pot/main/t-pot.user.js
// @downloadURL  https://raw.githubusercontent.com/clintzula/t-pot/main/t-pot.user.js
// @description  Notifies you with a desktop notification and sound when new tickets appear in SIM-T on refresh
// @author       clintzula (Luci DaProphet)
// @match        https://t.corp.amazon.com/issues*
// @match        https://t.corp.amazon.com/issues/*
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// ==/UserScript==
/************************************************************
 *  🫖 T-Pot — SIM-T Ticket Notifier
 *  Created by: clintzula (Luci DaProphet)
 *  GitHub:     https://github.com/clintzula/t-pot
 *
 *  CHANGELOG
 *  ─────────
 *  v2.32 — 2026-09-02
 *    • Default scrape delay reduced to 5000ms (from 10000ms)
 *    • Versioning convention: bump +0.01 per batch of ~3 changes
 *
 *  v2.31 — 2026-09-02
 *    • Notifications now show a short summarized ticket title next to the ID
 *    • "Johnny 5" titles are relabelled "J5" and take priority (path shown)
 *    • ALL-CAPS component/failure tokens are surfaced (e.g. VETTING_CBP_POWERSHELF)
 *    • Boilerplate ("Please repair", "problem with", QCI serials) stripped
 *    • Titles truncated on a word boundary; new "Show Ticket Titles" toggle and
 *      "Title Max Length" setting (default 60)
 *
 *  v2.30 — 2026-09-02
 *    • Ticket ID extraction now reads the /issues/ link href FIRST (most reliable),
 *      then the data attribute, then falls back to the loose cell-text regex
 *    • main() scrapes immediately on the first attempt; the scrape delay now only
 *      applies between retries (no more mandatory 10s wait on every load)
 *    • Severity filter matches whole numbers only (bare "1" no longer matches any
 *      digit-1 embedded in IDs, dates, or counts)
 *    • Stripped all blank lines
 *
 *  v2.29 — 2026-09-02
 *    • URL-keyed storage — each SIM-T view/filter has its own independent baseline
 *    • Auto-prunes old views (keeps last 20) to prevent storage bloat
 *  (older changelog entries trimmed — see git history)
 ************************************************************/
(function () {
    'use strict';
    // ──────────────────────────────────────────────
    // DEFAULT CONFIG & SETTINGS PERSISTENCE
    // ──────────────────────────────────────────────
    const DEFAULTS = {
        ticketRowSelector: 'tbody tr[data-selection-item="item"]',
        ticketIdAttr: 'data-ticket-id',
        scrapeDelay: 5000,
        soundEnabled: true,
        soundVolume: 0.6,           // 0.0 – 1.0
        notifSound: 'kettle',       // 'kettle', 'chime', 'bell', 'ping', 'alarm'
        detectAssigneeChanges: true, // notify when a watched assignee is added to existing ticket
        autoRefreshEnabled: true,
        autoRefreshMinutes: 2,
        desktopNotifEnabled: true,
        inPagePopupEnabled: true,     // in-page popup toast
        notifDurationSec: 8,
        showTicketTitles: true,     // show a short summarized title next to the ID
        titleMaxLength: 60,         // max chars for the summarized title
        // Filters — blank = notify for ALL
        filterAssignees: '',        // comma-separated aliases as shown on page, e.g. "alexyano, mdanju"
        filterSeverities: '',       // comma-separated severity numbers as shown, e.g. "1, 2, 3"
        filterTicketTypes: '',      // comma-separated, matches row text, e.g. "Boost, Pending"
        // Auto-refresh page exclusions — refresh is skipped on URLs matching these patterns
        refreshExcludePatterns: '/create, /edit, /bulk',
        compactBadge: false,         // hide label text, show only icon + timer
    };
    const SETTINGS_KEY = 'simt_notifier_settings';
    async function loadSettings() {
        const raw = await GM_getValue(SETTINGS_KEY, '{}');
        try {
            return { ...DEFAULTS, ...JSON.parse(raw) };
        } catch {
            return { ...DEFAULTS };
        }
    }
    async function saveSettings(settings) {
        await GM_setValue(SETTINGS_KEY, JSON.stringify(settings));
    }
    // CONFIG is mutable — updated by the settings GUI
    let CONFIG = { ...DEFAULTS };
    // ──────────────────────────────────────────────
    // SOUND SETUP — short beep via Web Audio API
    // ──────────────────────────────────────────────
    function playNotificationSound() {
        if (!CONFIG.soundEnabled) return;
        try {
            playSound(CONFIG.notifSound, CONFIG.soundVolume);
        } catch (e) {
            console.warn('[T-Pot] Could not play sound:', e);
        }
    }
    function playSound(type, volume) {
        const vol = Math.max(0, Math.min(1, volume ?? CONFIG.soundVolume));
        switch (type) {
            case 'chime':    playChimeClassic(vol); break;
            case 'bell':     playBell(vol); break;
            case 'ping':     playPing(vol); break;
            case 'alarm':    playAlarm(vol); break;
            case 'kettle':
            default:         playChime(vol); break;
        }
    }
    // 🔔 Classic two-tone chime
    function playChimeClassic(vol) {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        [520, 660].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(vol, ctx.currentTime + i * 0.15);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.4);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(ctx.currentTime + i * 0.15);
            osc.stop(ctx.currentTime + i * 0.15 + 0.4);
        });
    }
    // 🛎️ Desk bell — single resonant ding
    function playBell(vol) {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const t = ctx.currentTime;
        [880, 1760, 2640].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            const amplitude = vol * (i === 0 ? 0.5 : i === 1 ? 0.2 : 0.08);
            gain.gain.setValueAtTime(amplitude, t);
            gain.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(t);
            osc.stop(t + 1.3);
        });
    }
    // 📱 Short digital ping
    function playPing(vol) {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const t = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1200, t);
        osc.frequency.exponentialRampToValueAtTime(800, t + 0.15);
        gain.gain.setValueAtTime(vol * 0.5, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.35);
        // Second ping
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(1400, t + 0.2);
        osc2.frequency.exponentialRampToValueAtTime(1000, t + 0.35);
        gain2.gain.setValueAtTime(vol * 0.4, t + 0.2);
        gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.start(t + 0.2);
        osc2.stop(t + 0.55);
    }
    // 🚨 Urgent alarm — triple pulse
    function playAlarm(vol) {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const t = ctx.currentTime;
        [0, 0.25, 0.5].forEach((offset) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'square';
            osc.frequency.setValueAtTime(700, t + offset);
            osc.frequency.linearRampToValueAtTime(900, t + offset + 0.1);
            gain.gain.setValueAtTime(vol * 0.25, t + offset);
            gain.gain.linearRampToValueAtTime(0, t + offset + 0.18);
            const filter = ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 2000;
            osc.connect(filter);
            filter.connect(gain);
            gain.connect(ctx.destination);
            osc.start(t + offset);
            osc.stop(t + offset + 0.2);
        });
    }
    // 🫖 Tea kettle whistle (default)
    function playChime(volume) {
        const vol = Math.max(0, Math.min(1, volume ?? CONFIG.soundVolume));
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const t = ctx.currentTime;
        // Main whistle tone — high pitched like a real kettle
        const whistle = ctx.createOscillator();
        whistle.type = 'sine';
        whistle.frequency.setValueAtTime(2200, t);
        whistle.frequency.linearRampToValueAtTime(2800, t + 0.4);
        whistle.frequency.setValueAtTime(2800, t + 0.4);
        whistle.frequency.linearRampToValueAtTime(2650, t + 1.0);
        whistle.frequency.linearRampToValueAtTime(2750, t + 1.5);
        // Vibrato / flutter — simulates steam pulsing through the whistle
        const vibrato = ctx.createOscillator();
        vibrato.type = 'sine';
        vibrato.frequency.setValueAtTime(4, t);
        vibrato.frequency.linearRampToValueAtTime(8, t + 0.5);
        vibrato.frequency.setValueAtTime(8, t + 0.5);
        vibrato.frequency.linearRampToValueAtTime(6, t + 1.5);
        const vibratoGain = ctx.createGain();
        vibratoGain.gain.setValueAtTime(20, t);
        vibratoGain.gain.linearRampToValueAtTime(40, t + 0.5);
        vibratoGain.gain.setValueAtTime(40, t + 1.0);
        vibrato.connect(vibratoGain);
        vibratoGain.connect(whistle.frequency);
        // Steam hiss — white noise through a high bandpass for that airy quality
        const bufferSize = ctx.sampleRate * 2;
        const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
        const noise = ctx.createBufferSource();
        noise.buffer = noiseBuffer;
        const noiseFilter = ctx.createBiquadFilter();
        noiseFilter.type = 'bandpass';
        noiseFilter.frequency.value = 3500;
        noiseFilter.Q.value = 2;
        const noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(0, t);
        noiseGain.gain.linearRampToValueAtTime(vol * 0.08, t + 0.3);
        noiseGain.gain.setValueAtTime(vol * 0.08, t + 1.2);
        noiseGain.gain.linearRampToValueAtTime(0, t + 1.6);
        // Narrow bandpass on the whistle for that piercing, resonant quality
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(2800, t);
        filter.Q.value = 12;
        // Volume envelope — builds up like steam pressure, sustains, fades
        const mainGain = ctx.createGain();
        mainGain.gain.setValueAtTime(0, t);
        mainGain.gain.linearRampToValueAtTime(vol * 0.35, t + 0.3);
        mainGain.gain.setValueAtTime(vol * 0.35, t + 0.4);
        mainGain.gain.linearRampToValueAtTime(vol * 0.45, t + 0.8);
        mainGain.gain.setValueAtTime(vol * 0.45, t + 1.2);
        mainGain.gain.linearRampToValueAtTime(0, t + 1.6);
        // Wire it up
        whistle.connect(filter);
        filter.connect(mainGain);
        mainGain.connect(ctx.destination);
        noise.connect(noiseFilter);
        noiseFilter.connect(noiseGain);
        noiseGain.connect(ctx.destination);
        whistle.start(t);
        vibrato.start(t);
        noise.start(t);
        whistle.stop(t + 1.7);
        vibrato.stop(t + 1.7);
        noise.stop(t + 1.7);
    }
    // ──────────────────────────────────────────────
    // TICKET DATA EXTRACTION
    // ──────────────────────────────────────────────
    function extractTicketId(row) {
        // 1. Prefer the /issues/ link href — most reliable source of the real ID
        const link = row.querySelector('a[href*="/issues/"]') || row.querySelector('a[href*="/t.corp"]');
        if (link) {
            const match = link.href.match(/\/issues\/([A-Za-z0-9-]+)/);
            if (match) return match[1];
        }
        // 2. Try data attribute (if configured)
        const attrId = row.getAttribute(CONFIG.ticketIdAttr);
        if (attrId) return attrId.trim();
        // 3. Fallback: search all cells for a SIM-T ticket ID pattern (e.g. V2349367928)
        //    Loose match — only used when neither a link nor a data attribute is present.
        const cells = row.querySelectorAll('td');
        for (const cell of cells) {
            const text = cell.textContent.trim();
            const match = text.match(/([A-Z]\d{7,}|\b\d{8,})/i);
            if (match) return match[1];
        }
        return null;
    }
    function extractRowText(row) {
        // Returns the full text content of the row for filter matching
        return (row.textContent || '').toLowerCase();
    }
    function extractTitle(row) {
        // Grab the raw title text from the Title column.
        // SIM-T renders the title as a link in its own cell. We look for a link
        // whose href points at the ticket (/issues/<id>) but that ISN'T the Short ID
        // link, by preferring the longest such link text in the row.
        const links = Array.from(row.querySelectorAll('a[href*="/issues/"]'));
        let best = '';
        for (const a of links) {
            const txt = (a.textContent || '').trim();
            if (txt.length > best.length) best = txt;
        }
        if (best) return best;
        // Fallback: longest <td> text that isn't just the ID/severity/date.
        const cells = Array.from(row.querySelectorAll('td'));
        for (const cell of cells) {
            const txt = (cell.textContent || '').trim();
            if (txt.length > best.length) best = txt;
        }
        return best;
    }
    function summarizeTitle(rawTitle, maxLen) {
        // Turns a long, tag-heavy SIM-T title into a short, meaningful name.
        // Priority:
        //   1. "Johnny 5" (relabelled "J5") + the link path that follows it.
        //   2. ALL-CAPS component/failure tokens (e.g. VETTING_CBP_POWERSHELF).
        //   3. Bracketed tags / leftover text as a fallback.
        // Result is trimmed to maxLen on a token boundary.
        if (!rawTitle) return '';
        const cap = maxLen || 60;
        let title = rawTitle.replace(/\s+/g, ' ').trim();
        // Shorten arrow notation to save space.
        title = title.replace(/<\s*-\s*>/g, '↔');
        // 1. Johnny 5 → J5 + everything after it (that's the meaningful link path).
        const j5 = title.match(/johnny\s*5\s*\]?\s*(.*)$/i);
        if (j5) {
            let rest = (j5[1] || '').trim();
            // Trim any trailing lone bracket left over from the tag.
            rest = rest.replace(/^\]+\s*/, '').trim();
            let name = ('J5 ' + rest).trim();
            // If there's room, append the first ALL-CAPS component token for context.
            const capsToken = findCapsTokens(title)[0];
            if (capsToken && !name.toUpperCase().includes(capsToken) && name.length + capsToken.length + 3 <= cap) {
                name += ' · ' + capsToken;
            }
            return truncateOnBoundary(name, cap);
        }
        // 2. ALL-CAPS tokens — the component/failure signatures.
        const caps = findCapsTokens(title);
        if (caps.length > 0) {
            return truncateOnBoundary(caps.join(' · '), cap);
        }
        // 3. Fallback: strip boilerplate, then pick descriptive bracketed tags.
        let cleaned = title
            .replace(/please repair/ig, '')
            .replace(/problem with.*$/ig, '')
            .replace(/\bQCI\.[A-Z0-9]+\b/ig, '')
            .trim();
        const allBrackets = [...cleaned.matchAll(/\[([^\]]+)\]/g)].map(m => m[1].trim()).filter(Boolean);
        // Prefer descriptive bracket tags (real words / spaces) over region/build-plan
        // codes (RNO100 ..., EC2_BP_1, EC2.GB300R, ec2, Vetting).
        const descriptive = allBrackets.filter(b => {
            if (/^(ec2|vetting|training ticket)$/i.test(b)) return false;
            if (/_BP_\d+/.test(b)) return false;
            if (/^RNO\d/.test(b)) return false;
            if (/^[A-Z0-9]+\.[A-Z0-9]+$/.test(b)) return false; // EC2.GB300R
            if (/^[\d\s.-]+$/.test(b)) return false;             // pure number/rack tags
            return /\s/.test(b) || /[a-z]/.test(b);
        }).map(b => b.replace(/^repair:\s*/i, '').trim());
        if (descriptive.length > 0) {
            return truncateOnBoundary(descriptive.join(' · '), cap);
        }
        if (allBrackets.length > 0) {
            return truncateOnBoundary(allBrackets.join(' · '), cap);
        }
        return truncateOnBoundary(cleaned || title, cap);
    }
    function findCapsTokens(text) {
        // Strip serial-number payloads first (QCI.xxxx, DTA.LMITxxxx) so their caps
        // portions don't get picked up as tokens.
        const cleaned = text.replace(/\b[A-Z]{2,}\.[A-Z0-9]+\b/g, ' ');
        const matches = cleaned.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) || [];
        const NOISE = new Set(['QCI', 'RNO', 'DTA', 'LMIT', 'RNO100', 'EC2', 'ELB']);
        const isNoise = (m) => {
            if (NOISE.has(m)) return true;
            if (/_BP_\d+$/.test(m)) return true;               // EC2_BP_1, POWERSHELF_BP_1, NETWORK_BP_1
            if (/^[A-Z]{1,3}\d+[A-Z]?$/.test(m)) return true;  // GB300R style product codes
            if (/\d/.test(m) && !m.includes('_')) return true; // hardware codes: EC2GB300R, PWRRP48PSC
            if (/^[A-Z0-9]{12,}$/.test(m)) return true;        // long serial-ish blobs
            return false;
        };
        const scored = [];
        const seen = new Set();
        for (const m of matches) {
            const letters = (m.match(/[A-Z]/g) || []).length;
            if (letters < 2) continue;
            if (/^\d/.test(m)) continue;
            if (seen.has(m)) continue;
            seen.add(m);
            // Prefer descriptive component signatures (underscores + many letters).
            let score = letters;
            if (m.includes('_')) score += 5;
            if (isNoise(m)) score -= 20;
            scored.push({ m, score });
        }
        return scored
            .filter(x => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .map(x => x.m);
    }
    function truncateOnBoundary(str, maxLen) {
        const s = (str || '').trim();
        if (s.length <= maxLen) return s;
        // Cut at the last space before the limit so we don't split a word/token.
        const slice = s.slice(0, maxLen - 1);
        const lastSpace = slice.lastIndexOf(' ');
        const cut = lastSpace > maxLen * 0.5 ? slice.slice(0, lastSpace) : slice;
        return cut.trim() + '…';
    }
    function scrapeCurrentTickets() {
        const selector = CONFIG.ticketRowSelector;
        console.log('[T-Pot] Scraping with selector:', selector);
        let rows;
        try {
            rows = document.querySelectorAll(selector);
        } catch (e) {
            console.warn('[T-Pot] Invalid selector, falling back to default:', e.message);
            rows = document.querySelectorAll(DEFAULTS.ticketRowSelector);
        }
        console.log('[T-Pot] querySelectorAll result:', rows.length, 'rows');
        // Fallback: if primary selector fails, try broader selectors
        if (rows.length === 0) {
            console.log('[T-Pot] Primary selector failed, trying fallbacks...');
            const fallbacks = [
                'tbody tr[aria-rowindex]',
                'tbody tr[data-selection-item]',
                'tr[aria-rowindex]',
                'table tbody tr',
                'tbody tr',
            ];
            for (const fb of fallbacks) {
                rows = document.querySelectorAll(fb);
                console.log(`[T-Pot]   Fallback "${fb}": ${rows.length} rows`);
                if (rows.length > 0) break;
            }
        }
        const tickets = []; // {id, rowText, title}
        rows.forEach(row => {
            // Skip category header rows
            if (row.classList.contains('category-label')) return;
            const id = extractTicketId(row);
            if (id) {
                const rawTitle = extractTitle(row);
                const title = summarizeTitle(rawTitle, CONFIG.titleMaxLength);
                tickets.push({ id, rowText: extractRowText(row), title });
            }
        });
        console.log('[T-Pot] Extracted', tickets.length, 'tickets with IDs');
        if (tickets.length > 0) {
            console.log('[T-Pot] Sample IDs:', tickets.slice(0, 3).map(t => t.id));
        }
        return tickets;
    }
    // ──────────────────────────────────────────────
    // TICKET FILTERING
    // ──────────────────────────────────────────────
    function parseCSVFilter(str) {
        if (!str || !str.trim()) return [];
        return str.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    }
    function severityMatches(text, severities) {
        // Match a severity number only as a whole token (e.g. "sev 2", "sev-2", "2")
        // so a bare "1" doesn't match digits inside IDs, dates, or counts.
        return severities.some(s => {
            const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`(?:^|[^0-9])${esc}(?:$|[^0-9])`);
            return re.test(text);
        });
    }
    function ticketMatchesFilters(ticket) {
        const assignees = parseCSVFilter(CONFIG.filterAssignees);
        const severities = parseCSVFilter(CONFIG.filterSeverities);
        const types = parseCSVFilter(CONFIG.filterTicketTypes);
        // If ALL filters are empty, notify for everything
        if (assignees.length === 0 && severities.length === 0 && types.length === 0) {
            return true;
        }
        const text = ticket.rowText;
        // Each non-empty filter must match (AND logic between categories)
        // Within a category it's OR logic (any match counts)
        if (assignees.length > 0 && !assignees.some(a => text.includes(a))) return false;
        if (severities.length > 0 && !severityMatches(text, severities)) return false;
        if (types.length > 0 && !types.some(t => text.includes(t))) return false;
        return true;
    }
    // ──────────────────────────────────────────────
    // DESKTOP NOTIFICATION
    // ──────────────────────────────────────────────
    function requestNotificationPermission() {
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    }
    function showDesktopNotification(tickets) {
        if (!CONFIG.desktopNotifEnabled) return;
        const count = tickets.length;
        const newCount = tickets.filter(t => t.reason === 'new').length;
        const reassignCount = tickets.filter(t => t.reason === 'assignee').length;
        // Build a clear title showing what happened
        const titleParts = [];
        if (newCount > 0) titleParts.push(`${newCount} New`);
        if (reassignCount > 0) titleParts.push(`${reassignCount} Reassigned`);
        const title = `🫖 ${titleParts.join(' + ')} — T-Pot`;
        // Build body with reason labels per ticket
        const showTitle = CONFIG.showTicketTitles;
        const lines = tickets.slice(0, 5).map(t => {
            const titleSuffix = (showTitle && t.title) ? ` — ${t.title}` : '';
            if (t.reason === 'assignee') return `🔄 ${t.id}${titleSuffix} → ${t.matchedAssignee}`;
            return `🆕 ${t.id}${titleSuffix}`;
        });
        if (count > 5) lines.push(`...and ${count - 5} more`);
        const body = lines.join('\n');
        if ('Notification' in window && Notification.permission === 'granted') {
            const notif = new Notification(title, {
                body: body,
                icon: 'https://t.corp.amazon.com/favicon.ico',
                tag: 't-pot-new-tickets',
                requireInteraction: false,
            });
            notif.onclick = () => {
                window.focus();
                notif.close();
            };
            setTimeout(() => notif.close(), CONFIG.notifDurationSec * 1000);
        } else {
            GM_notification({
                title: title,
                text: body,
                timeout: CONFIG.notifDurationSec * 1000,
            });
        }
    }
    // ──────────────────────────────────────────────
    // IN-PAGE POPUP TOAST
    // Slides in from top-right with clickable ticket links
    // ──────────────────────────────────────────────
    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
    function showInPagePopup(tickets) {
        if (!CONFIG.inPagePopupEnabled) return;
        // Remove any existing popup
        const existing = document.getElementById('tpot-popup');
        if (existing) existing.remove();
        const popup = document.createElement('div');
        popup.id = 'tpot-popup';
        popup.style.cssText = `
            position: fixed;
            top: 16px;
            right: 16px;
            z-index: 9999997;
            width: 360px;
            max-width: 90vw;
            max-height: 400px;
            background: #1a1a2e;
            border: 2px solid #ff9900;
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            font-family: 'Amazon Ember', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            overflow: hidden;
            transform: translateX(420px);
            transition: transform 0.35s ease;
        `;
        const count = tickets.length;
        const newCount = tickets.filter(t => t.reason === 'new').length;
        const reassignCount = tickets.filter(t => t.reason === 'assignee').length;
        const headerParts = [];
        if (newCount > 0) headerParts.push(`${newCount} New`);
        if (reassignCount > 0) headerParts.push(`${reassignCount} Reassigned`);
        popup.innerHTML = `
            <div style="
                display: flex; align-items: center; justify-content: space-between;
                padding: 12px 16px; background: #16213e; border-bottom: 1px solid #333;
            ">
                <div style="font-size: 15px; font-weight: 700; color: #ff9900;">
                    🫖 ${headerParts.join(' + ')}
                </div>
                <button id="tpot-popup-close" style="
                    background: none; border: none; color: #888; font-size: 20px;
                    cursor: pointer; padding: 0 4px; line-height: 1;
                    transition: color 0.15s;
                ">&times;</button>
            </div>
            <div id="tpot-popup-list" style="
                padding: 8px 0; max-height: 300px; overflow-y: auto;
            ">
                ${tickets.map(t => {
                    const icon = t.reason === 'assignee' ? '🔄' : '🆕';
                    const badge = t.reason === 'assignee'
                        ? '<span style="background:#2d4a7a; color:#7cb3ff; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:600;">REASSIGNED → ' + escapeHtml(t.matchedAssignee || '') + '</span>'
                        : '<span style="background:#2d6b3a; color:#7cff93; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:600;">NEW TICKET</span>';
                    const titleHtml = (CONFIG.showTicketTitles && t.title)
                        ? '<div style="margin-top:3px; font-size:12px; color:#b8b8c8; font-weight:400; line-height:1.3;">' + escapeHtml(t.title) + '</div>'
                        : '';
                    return `
                    <a href="https://t.corp.amazon.com/issues/${encodeURIComponent(t.id)}"
                       target="_blank"
                       style="
                           display: flex; align-items: center; gap: 10px;
                           padding: 10px 16px; color: #e0e0e0; text-decoration: none;
                           font-size: 14px; transition: background 0.15s;
                           border-bottom: 1px solid rgba(255,255,255,0.05);
                       "
                       onmouseenter="this.style.background='#2a2a3e'"
                       onmouseleave="this.style.background='transparent'">
                        <span style="font-size: 18px;">${icon}</span>
                        <div style="flex:1; min-width:0;">
                            <div style="font-weight: 600;">${escapeHtml(t.id)}</div>
                            ${titleHtml}
                            <div style="margin-top:3px;">${badge}</div>
                        </div>
                        <span style="color: #ff9900; font-size: 12px; white-space:nowrap;">Open →</span>
                    </a>`;
                }).join('')}
            </div>
            <div style="
                padding: 8px 16px; background: #16213e;
                border-top: 1px solid #333; text-align: center;
            ">
                <button id="tpot-popup-dismiss" style="
                    background: #ff9900; color: #1a1a2e; border: none;
                    padding: 6px 24px; border-radius: 6px; font-size: 13px;
                    font-weight: 600; cursor: pointer; transition: background 0.15s;
                ">Dismiss</button>
            </div>
        `;
        document.body.appendChild(popup);
        // Slide in
        requestAnimationFrame(() => {
            popup.style.transform = 'translateX(0)';
        });
        // Close handlers
        const closePopup = () => {
            popup.style.transform = 'translateX(420px)';
            setTimeout(() => popup.remove(), 400);
        };
        document.getElementById('tpot-popup-close').addEventListener('click', closePopup);
        document.getElementById('tpot-popup-dismiss').addEventListener('click', closePopup);
        // Hover over close button changes color
        const closeBtn = document.getElementById('tpot-popup-close');
        closeBtn.addEventListener('mouseenter', () => closeBtn.style.color = '#fff');
        closeBtn.addEventListener('mouseleave', () => closeBtn.style.color = '#888');
        // Auto-dismiss after notification duration
        setTimeout(closePopup, CONFIG.notifDurationSec * 1000);
    }
    // ──────────────────────────────────────────────
    // STORAGE (URL-keyed — each view has its own baseline)
    // ──────────────────────────────────────────────
    const STORAGE_KEY_V3 = 'simt_tickets_by_view'; // {viewKey: {id: rowText, ...}, ...}
    function getViewKey() {
        // Normalize the URL to create a stable key per view
        // Use pathname + query string (the filter), ignore hash and transient params
        const url = new URL(window.location.href);
        const path = url.pathname;
        const query = url.searchParams.get('q') || '';
        // Create a short hash of the query to keep the key manageable
        let hash = 0;
        const fullKey = path + '?' + query;
        for (let i = 0; i < fullKey.length; i++) {
            hash = ((hash << 5) - hash + fullKey.charCodeAt(i)) | 0;
        }
        const key = path + '_' + Math.abs(hash).toString(36);
        console.log('[T-Pot] View key:', key);
        return key;
    }
    async function getAllViewData() {
        const raw = await GM_getValue(STORAGE_KEY_V3, '{}');
        try {
            return JSON.parse(raw);
        } catch {
            return {};
        }
    }
    async function getStoredTickets() {
        const allViews = await getAllViewData();
        const key = getViewKey();
        return allViews[key] || {};
    }
    async function storeTickets(ticketMap) {
        const allViews = await getAllViewData();
        const key = getViewKey();
        allViews[key] = ticketMap;
        // Prune old views to prevent storage bloat (keep last 20 views)
        const keys = Object.keys(allViews);
        if (keys.length > 20) {
            const toRemove = keys.slice(0, keys.length - 20);
            for (const k of toRemove) delete allViews[k];
            console.log(`[T-Pot] Pruned ${toRemove.length} old view(s) from storage.`);
        }
        await GM_setValue(STORAGE_KEY_V3, JSON.stringify(allViews));
    }
    // ──────────────────────────────────────────────
    // MAIN LOGIC
    // ──────────────────────────────────────────────
    async function main() {
        requestNotificationPermission();
        // Wait for SIM-T and other scripts (Better Search, etc.) to finish rendering.
        // Scrape immediately on the first attempt; only delay between retries.
        let allTickets = [];
        const maxRetries = 5;
        const retryDelay = CONFIG.scrapeDelay;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            if (attempt > 1) {
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
            allTickets = scrapeCurrentTickets();
            if (allTickets.length > 0) {
                console.log(`[T-Pot] Found ${allTickets.length} tickets on attempt ${attempt}.`);
                break;
            }
            if (attempt < maxRetries) {
                console.log(`[T-Pot] No tickets found (attempt ${attempt}/${maxRetries}), retrying in ${retryDelay/1000}s...`);
            }
        }
        // Build a map of {id: rowText} for current tickets
        const currentMap = {};
        for (const t of allTickets) {
            currentMap[t.id] = t.rowText;
        }
        if (Object.keys(currentMap).length === 0) {
            console.log('[T-Pot] No tickets found after all retries. Selectors may need updating.');
            return;
        }
        const storedMap = await getStoredTickets();
        const storedIds = Object.keys(storedMap);
        // First run — just store, don't alert
        if (storedIds.length === 0) {
            console.log(`[T-Pot] First run — stored ${Object.keys(currentMap).length} tickets.`);
            await storeTickets(currentMap);
            return;
        }
        // 1. Find brand-new tickets (ID not in stored)
        const newTickets = allTickets.filter(t => !(t.id in storedMap));
        // 2. Find assignee-changed tickets (ID exists but row text changed & matches a watched assignee)
        const changedTickets = [];
        if (CONFIG.detectAssigneeChanges) {
            const watchedAssignees = parseCSVFilter(CONFIG.filterAssignees);
            console.log('[T-Pot] Assignee change detection ON. Watched assignees:', watchedAssignees);
            if (watchedAssignees.length > 0) {
                let changesChecked = 0;
                let rowsChanged = 0;
                for (const t of allTickets) {
                    if (t.id in storedMap && storedMap[t.id] !== t.rowText) {
                        rowsChanged++;
                        const oldText = storedMap[t.id];
                        // Skip if old text is empty (v1→v2 migration, no baseline to compare)
                        if (!oldText) continue;
                        for (const assignee of watchedAssignees) {
                            if (t.rowText.includes(assignee) && !oldText.includes(assignee)) {
                                changedTickets.push({ ...t, reason: 'assignee', matchedAssignee: assignee });
                                console.log(`[T-Pot] 🔄 Assignee change detected on ${t.id}: "${assignee}" now assigned`);
                                break;
                            }
                        }
                    }
                    changesChecked++;
                }
                console.log(`[T-Pot] Checked ${changesChecked} tickets, ${rowsChanged} had row changes, ${changedTickets.length} matched assignee filter.`);
            } else {
                console.log('[T-Pot] No watched assignees configured — skipping assignee change detection.');
            }
        }
        // Combine tickets for notification based on mode
        let matchingNew = [];
        if (CONFIG.detectAssigneeChanges) {
            // ASSIGNEE-ONLY MODE: only the assignee filter matters
            const watchedAssignees = parseCSVFilter(CONFIG.filterAssignees);
            if (watchedAssignees.length > 0) {
                matchingNew = newTickets.filter(t => {
                    return watchedAssignees.some(a => t.rowText.includes(a));
                }).map(t => {
                    const matched = watchedAssignees.find(a => t.rowText.includes(a));
                    return { ...t, reason: 'new', matchedAssignee: matched };
                });
                console.log(`[T-Pot] Assignee-only mode: ${matchingNew.length} of ${newTickets.length} new tickets match assignee filter.`);
            } else {
                console.log('[T-Pot] Assignee-only mode ON but no assignees configured — no notifications.');
            }
        } else {
            // NORMAL MODE: apply all filters (assignee + severity + keywords)
            matchingNew = newTickets.filter(ticketMatchesFilters).map(t => ({
                ...t, reason: 'new'
            }));
        }
        const allMatching = [...matchingNew, ...changedTickets];
        if (allMatching.length > 0) {
            const newCount = matchingNew.length;
            const changedCount = changedTickets.length;
            const label = [
                newCount > 0 ? `${newCount} new` : '',
                changedCount > 0 ? `${changedCount} reassigned` : '',
            ].filter(Boolean).join(', ');
            console.log(`[T-Pot] 🆕 ${label} ticket(s) matched filters:`, allMatching.map(t => t.id));
            showDesktopNotification(allMatching);
            showInPagePopup(allMatching);
            playNotificationSound();
        } else {
            if (newTickets.length > 0 || changedTickets.length > 0) {
                console.log(`[T-Pot] ${newTickets.length} new + ${changedTickets.length} changed ticket(s) found but none matched filters.`);
            } else {
                console.log('[T-Pot] No new tickets since last visit.');
            }
        }
        // Update stored tickets to current state
        await storeTickets(currentMap);
    }
    // ──────────────────────────────────────────────
    // SETTINGS GUI STYLES
    // ──────────────────────────────────────────────
    const PANEL_STYLES = `
        #simt-settings-overlay {
            position: fixed; inset: 0; z-index: 9999998;
            background: rgba(0,0,0,0.45); opacity: 0;
            pointer-events: none;
            transition: opacity 0.25s ease;
        }
        #simt-settings-overlay.open { opacity: 1; pointer-events: auto; }
        #simt-settings-panel {
            position: fixed;
            top: 0; left: -480px; bottom: 0;
            z-index: 9999999;
            width: 460px; max-width: 95vw;
            max-height: 100vh;
            background: #1a1a2e; color: #e0e0e0;
            font-family: 'Amazon Ember', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 14px;
            box-shadow: 4px 0 24px rgba(0,0,0,0.5);
            display: flex; flex-direction: column;
            border-right: 3px solid #ff9900;
            transition: left 0.3s ease;
            overflow: hidden;
        }
        #simt-settings-panel.open {
            left: 0;
        }
        .simt-panel-header {
            display: flex; align-items: center; justify-content: space-between;
            padding: 18px 20px; border-bottom: 1px solid #333;
            background: #16213e;
        }
        .simt-panel-header h2 {
            margin: 0; font-size: 17px; font-weight: 700; color: #ff9900;
        }
        .simt-panel-close {
            background: none; border: none; color: #aaa; font-size: 22px;
            cursor: pointer; padding: 4px 8px; border-radius: 4px;
            transition: background 0.15s, color 0.15s;
        }
        .simt-panel-close:hover { background: #333; color: #fff; }
        .simt-panel-body { flex: 1; overflow-y: auto; padding: 16px 20px; min-height: 0; }
        .simt-section { margin-bottom: 24px; }
        .simt-section-title {
            font-size: 12px; font-weight: 700; text-transform: uppercase;
            letter-spacing: 1px; color: #ff9900; margin-bottom: 12px;
            padding-bottom: 6px; border-bottom: 1px solid #333;
        }
        .simt-setting-row {
            display: flex; align-items: center; justify-content: space-between;
            padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.06);
        }
        .simt-setting-row:last-child { border-bottom: none; }
        .simt-setting-label { flex: 1; }
        .simt-setting-label .label-main { font-weight: 600; color: #e0e0e0; }
        .simt-setting-label .label-desc {
            font-size: 12px; color: #888; margin-top: 2px;
        }
        /* Toggle switch */
        .simt-toggle { position: relative; width: 44px; height: 24px; flex-shrink: 0; }
        .simt-toggle input { opacity: 0; width: 0; height: 0; }
        .simt-toggle .slider {
            position: absolute; inset: 0; background: #444; border-radius: 24px;
            cursor: pointer; transition: background 0.25s;
        }
        .simt-toggle .slider::before {
            content: ''; position: absolute; width: 18px; height: 18px;
            left: 3px; bottom: 3px; background: #fff; border-radius: 50%;
            transition: transform 0.25s;
        }
        .simt-toggle input:checked + .slider { background: #ff9900; }
        .simt-toggle input:checked + .slider::before { transform: translateX(20px); }
        /* Number / text inputs */
        .simt-input {
            width: 70px; padding: 6px 10px; background: #2a2a3e; border: 1px solid #444;
            border-radius: 6px; color: #e0e0e0; font-size: 14px; text-align: center;
            transition: border-color 0.2s;
        }
        .simt-input:focus { outline: none; border-color: #ff9900; }
        .simt-input-wide { width: 100%; text-align: left; margin-top: 6px; }
        /* Volume slider */
        .simt-range {
            -webkit-appearance: none; appearance: none;
            width: 100px; height: 6px; border-radius: 3px;
            background: #444; outline: none;
            transition: background 0.2s;
        }
        .simt-range::-webkit-slider-thumb {
            -webkit-appearance: none; appearance: none;
            width: 18px; height: 18px; border-radius: 50%;
            background: #ff9900; cursor: pointer;
            border: 2px solid #232f3e;
        }
        .simt-range::-moz-range-thumb {
            width: 18px; height: 18px; border-radius: 50%;
            background: #ff9900; cursor: pointer;
            border: 2px solid #232f3e;
        }
        .simt-volume-display {
            font-size: 12px; color: #aaa; min-width: 32px; text-align: right;
        }
        /* Buttons */
        .simt-panel-footer {
            padding: 14px 20px; border-top: 1px solid #333;
            display: flex; gap: 10px; justify-content: flex-end; background: #16213e;
        }
        .simt-btn {
            padding: 8px 20px; border: none; border-radius: 6px; font-size: 14px;
            font-weight: 600; cursor: pointer; transition: background 0.15s, transform 0.1s;
        }
        .simt-btn:active { transform: scale(0.97); }
        .simt-btn-primary { background: #ff9900; color: #1a1a2e; }
        .simt-btn-primary:hover { background: #ffad33; }
        .simt-btn-secondary { background: #333; color: #ccc; }
        .simt-btn-secondary:hover { background: #444; }
        .simt-btn-danger { background: transparent; color: #e74c3c; border: 1px solid #e74c3c; }
        .simt-btn-danger:hover { background: #e74c3c; color: #fff; }
        .simt-btn-test { background: transparent; color: #ff9900; border: 1px solid #ff9900; padding: 4px 12px; font-size: 12px; }
        .simt-btn-test:hover { background: #ff9900; color: #1a1a2e; }
        .simt-signature {
            text-align: center; padding: 10px 20px 14px;
            border-top: 1px solid #333; background: #16213e;
            font-size: 11px; color: #666;
        }
        .simt-signature a {
            color: #ff9900; text-decoration: none;
        }
        .simt-signature a:hover { text-decoration: underline; }
    `;
    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = PANEL_STYLES;
        document.head.appendChild(style);
    }
    // ──────────────────────────────────────────────
    // SETTINGS GUI PANEL
    // ──────────────────────────────────────────────
    function createSettingsPanel() {
        injectStyles();
        const overlay = document.createElement('div');
        overlay.id = 'simt-settings-overlay';
        overlay.addEventListener('click', closeSettingsPanel);
        document.body.appendChild(overlay);
        const panel = document.createElement('div');
        panel.id = 'simt-settings-panel';
        panel.innerHTML = `
            <div class="simt-panel-header">
                <h2>🫖 T-Pot Settings</h2>
                <button class="simt-panel-close" id="simt-close-btn">&times;</button>
            </div>
            <div class="simt-panel-body">
                <!-- NOTIFICATIONS SECTION -->
                <div class="simt-section">
                    <div class="simt-section-title">Notifications</div>
                    <div class="simt-setting-row">
                        <div class="simt-setting-label">
                            <div class="label-main">Desktop Notifications</div>
                            <div class="label-desc">Browser push notifications (appear even when tab is not focused)</div>
                        </div>
                        <label class="simt-toggle">
                            <input type="checkbox" id="simt-s-desktopNotif" ${CONFIG.desktopNotifEnabled ? 'checked' : ''}>
                            <span class="slider"></span>
                        </label>
                    </div>
                    <div class="simt-setting-row">
                        <div class="simt-setting-label">
                            <div class="label-main">In-Page Popup</div>
                            <div class="label-desc">Slide-in popup on the page with clickable ticket links</div>
                        </div>
                        <label class="simt-toggle">
                            <input type="checkbox" id="simt-s-inPagePopup" ${CONFIG.inPagePopupEnabled ? 'checked' : ''}>
                            <span class="slider"></span>
                        </label>
                    </div>
                    <div class="simt-setting-row">
                        <div class="simt-setting-label">
                            <div class="label-main">Sound Alert</div>
                            <div class="label-desc">Play a chime when new tickets are detected</div>
                        </div>
                        <div style="display:flex; align-items:center; gap:8px;">
                            <button class="simt-btn simt-btn-test" id="simt-test-sound">Test 🔊</button>
                            <label class="simt-toggle">
                                <input type="checkbox" id="simt-s-sound" ${CONFIG.soundEnabled ? 'checked' : ''}>
                                <span class="slider"></span>
                            </label>
                        </div>
                    </div>
                    <div class="simt-setting-row">
                        <div class="simt-setting-label">
                            <div class="label-main">Notification Sound</div>
                            <div class="label-desc">Choose your alert sound</div>
                        </div>
                        <select id="simt-s-notifSound" style="
                            padding: 6px 10px; background: #2a2a3e; border: 1px solid #444;
                            border-radius: 6px; color: #e0e0e0; font-size: 13px;
                        ">
                            <option value="kettle" ${CONFIG.notifSound === 'kettle' ? 'selected' : ''}>🫖 Tea Kettle</option>
                            <option value="chime" ${CONFIG.notifSound === 'chime' ? 'selected' : ''}>🔔 Classic Chime</option>
                            <option value="bell" ${CONFIG.notifSound === 'bell' ? 'selected' : ''}>🛎️ Desk Bell</option>
                            <option value="ping" ${CONFIG.notifSound === 'ping' ? 'selected' : ''}>📱 Digital Ping</option>
                            <option value="alarm" ${CONFIG.notifSound === 'alarm' ? 'selected' : ''}>🚨 Urgent Alarm</option>
                        </select>
                    </div>
                    <div class="simt-setting-row">
                        <div class="simt-setting-label">
                            <div class="label-main">Volume</div>
                            <div class="label-desc">Notification sound volume</div>
                        </div>
                        <div style="display:flex; align-items:center; gap:10px;">
                            <span style="font-size:14px;">🔈</span>
                            <input type="range" class="simt-range" id="simt-s-volume" min="0" max="100" value="${Math.round(CONFIG.soundVolume * 100)}">
                            <span style="font-size:14px;">🔊</span>
                            <span class="simt-volume-display" id="simt-volume-pct">${Math.round(CONFIG.soundVolume * 100)}%</span>
                        </div>
                    </div>
                    <div class="simt-setting-row">
                        <div class="simt-setting-label">
                            <div class="label-main">Notification Duration</div>
                            <div class="label-desc">Seconds before auto-close (1–30)</div>
                        </div>
                        <input type="number" class="simt-input" id="simt-s-notifDur" min="1" max="30" value="${CONFIG.notifDurationSec}">
                    </div>
                    <div class="simt-setting-row">
                        <div class="simt-setting-label">
                            <div class="label-main">Show Ticket Titles</div>
                            <div class="label-desc">Show a short summarized title next to each ticket ID (J5 paths and ALL-CAPS components are prioritized)</div>
                        </div>
                        <label class="simt-toggle">
                            <input type="checkbox" id="simt-s-showTitles" ${CONFIG.showTicketTitles ? 'checked' : ''}>
                            <span class="slider"></span>
                        </label>
                    </div>
                    <div class="simt-setting-row">
                        <div class="simt-setting-label">
                            <div class="label-main">Title Max Length</div>
                            <div class="label-desc">Max characters for the summarized title (20–120)</div>
                        </div>
                        <input type="number" class="simt-input" id="simt-s-titleMaxLen" min="20" max="120" value="${CONFIG.titleMaxLength}">
                    </div>
                </div>
                <!-- FILTERS SECTION -->
                <div class="simt-section">
                    <div class="simt-section-title">Filters</div>
                    <p style="font-size:12px; color:#888; margin:0 0 12px;">
                        Only notify when new tickets match <strong>all</strong> non-empty filters below.
                        Leave a field blank to skip that filter. Separate multiple values with commas.
                    </p>
                    <div class="simt-setting-row">
                        <div class="simt-setting-label">
                            <div class="label-main">Detect Assignee(s) ONLY</div>
                            <div class="label-desc">When ON, ONLY the assignee filter is used — severity, keywords, and type filters are ignored. Notifies for new tickets and reassignments matching your assignees.</div>
                        </div>
                        <label class="simt-toggle">
                            <input type="checkbox" id="simt-s-detectAssignee" ${CONFIG.detectAssigneeChanges ? 'checked' : ''}>
                            <span class="slider"></span>
                        </label>
                    </div>
                    <div style="margin-bottom: 12px;">
                        <div class="simt-setting-label">
                            <div class="label-main">Assignee(s)</div>
                            <div class="label-desc">Only notify for tickets assigned to these usernames as shown on the page (e.g. alexyano, mdanju)</div>
                        </div>
                        <input type="text" class="simt-input simt-input-wide" id="simt-s-filterAssignees"
                               value="${CONFIG.filterAssignees}" placeholder="e.g. alexyano, mdanju, lucclint">
                    </div>
                    <div style="margin-bottom: 12px;">
                        <div class="simt-setting-label">
                            <div class="label-main">Severity</div>
                            <div class="label-desc">Only notify for these severity numbers as shown on the page (e.g. 1, 2, 3)</div>
                        </div>
                        <input type="text" class="simt-input simt-input-wide" id="simt-s-filterSeverities"
                               value="${CONFIG.filterSeverities}" placeholder="e.g. 1, 2, 3">
                    </div>
                    <div style="margin-bottom: 12px;">
                        <div class="simt-setting-label">
                            <div class="label-main">Keywords / Ticket Type</div>
                            <div class="label-desc">Only notify when row text contains these keywords (e.g. Boost, Vetting, Connectivity)</div>
                        </div>
                        <input type="text" class="simt-input simt-input-wide" id="simt-s-filterTypes"
                               value="${CONFIG.filterTicketTypes}" placeholder="e.g. Boost, Vetting, Connectivity">
                    </div>
                </div>
                <!-- AUTO-REFRESH SECTION -->
                <div class="simt-section">
                    <div class="simt-section-title">Auto-Refresh</div>
                    <div class="simt-setting-row">
                        <div class="simt-setting-label">
                            <div class="label-main">Auto-Refresh</div>
                            <div class="label-desc">Reload the page periodically to check for new tickets</div>
                        </div>
                        <label class="simt-toggle">
                            <input type="checkbox" id="simt-s-autoRefresh" ${CONFIG.autoRefreshEnabled ? 'checked' : ''}>
                            <span class="slider"></span>
                        </label>
                    </div>
                    <div class="simt-setting-row">
                        <div class="simt-setting-label">
                            <div class="label-main">Refresh Interval</div>
                            <div class="label-desc">Minutes between refreshes (1–60)</div>
                        </div>
                        <input type="number" class="simt-input" id="simt-s-interval" min="1" max="60" value="${CONFIG.autoRefreshMinutes}">
                    </div>
                </div>
                <!-- APPEARANCE SECTION -->
                <div class="simt-section">
                    <div class="simt-section-title">Appearance</div>
                    <div class="simt-setting-row">
                        <div class="simt-setting-label">
                            <div class="label-main">Compact Badge</div>
                            <div class="label-desc">Hide the label text — only show the icon, timer, and settings gear</div>
                        </div>
                        <label class="simt-toggle">
                            <input type="checkbox" id="simt-s-compactBadge" ${CONFIG.compactBadge ? 'checked' : ''}>
                            <span class="slider"></span>
                        </label>
                    </div>
                </div>
                <!-- ADVANCED SECTION -->
                <div class="simt-section">
                    <div class="simt-section-title">Advanced</div>
                    <div class="simt-setting-row">
                        <div class="simt-setting-label">
                            <div class="label-main">Scrape Delay (ms)</div>
                            <div class="label-desc">Wait time between retries when SIM-T hasn't rendered tickets yet</div>
                        </div>
                        <input type="number" class="simt-input" id="simt-s-scrapeDelay" min="500" max="10000" step="500" value="${CONFIG.scrapeDelay}">
                    </div>
                    <div style="margin-top: 10px;">
                        <div class="simt-setting-label">
                            <div class="label-main">Ticket Row Selector</div>
                            <div class="label-desc">CSS selector to match ticket rows (advanced)</div>
                        </div>
                        <input type="text" class="simt-input simt-input-wide" id="simt-s-selector" value="${CONFIG.ticketRowSelector}">
                    </div>
                    <div style="margin-top: 10px;">
                        <div class="simt-setting-label">
                            <div class="label-main">Ticket ID Attribute</div>
                            <div class="label-desc">data-attribute on rows containing the ticket ID</div>
                        </div>
                        <input type="text" class="simt-input simt-input-wide" id="simt-s-idAttr" value="${CONFIG.ticketIdAttr}">
                    </div>
                    <div style="margin-top: 10px;">
                        <div class="simt-setting-label">
                            <div class="label-main">Auto-Refresh Excluded URL Patterns</div>
                            <div class="label-desc">
                                Auto-refresh is paused on pages matching these patterns (comma-separated).
                                The script only runs on /issues pages by default. To add more pages,
                                edit the @match rules in the Tampermonkey script header.
                            </div>
                        </div>
                        <input type="text" class="simt-input simt-input-wide" id="simt-s-excludePatterns"
                               value="${CONFIG.refreshExcludePatterns}"
                               placeholder="/create, /edit, /bulk">
                    </div>
                </div>
            </div>
            <div class="simt-panel-footer">
                <button class="simt-btn simt-btn-danger" id="simt-reset-btn">Reset Defaults</button>
                <div style="flex:1;"></div>
                <button class="simt-btn simt-btn-secondary" id="simt-cancel-btn">Cancel</button>
                <button class="simt-btn simt-btn-primary" id="simt-save-btn">Save & Apply</button>
            </div>
            <div class="simt-signature">
                🫖 T-Pot v2.32 — Created by
                <a href="https://github.com/clintzula" target="_blank">clintzula</a>
                (Luci DaProphet)
            </div>
        `;
        document.body.appendChild(panel);
        // Wire up buttons
        document.getElementById('simt-close-btn').addEventListener('click', closeSettingsPanel);
        document.getElementById('simt-cancel-btn').addEventListener('click', closeSettingsPanel);
        document.getElementById('simt-save-btn').addEventListener('click', applyAndSaveSettings);
        document.getElementById('simt-reset-btn').addEventListener('click', resetSettings);
        document.getElementById('simt-test-sound').addEventListener('click', () => {
            const vol = parseInt(document.getElementById('simt-s-volume').value) / 100;
            const selectedSound = document.getElementById('simt-s-notifSound').value;
            playSound(selectedSound, vol);
            // Also show desktop notification + in-page popup if their toggles are on
            const testTickets = [{id: 'TEST-1234', reason: 'new', rowText: 'test', title: 'J5 rno100-100-es-m1-p14-t1-r16 jrp41-1 ↔ rno100…'}];
            if (document.getElementById('simt-s-desktopNotif').checked) {
                showDesktopNotification(testTickets);
            }
            if (document.getElementById('simt-s-inPagePopup').checked) {
                const origPopup = CONFIG.inPagePopupEnabled;
                CONFIG.inPagePopupEnabled = true;
                showInPagePopup([
                    {id: 'TEST-1234', reason: 'new', rowText: 'test', title: 'J5 rno100-100-es-m1-p14-t1-r16 jrp41-1 ↔ rno100…'},
                    {id: 'TEST-5678', reason: 'assignee', matchedAssignee: 'lucclint', rowText: 'test', title: 'VETTING_CBP_POWERSHELF · POWERSHELF_BP_1'}
                ]);
                CONFIG.inPagePopupEnabled = origPopup;
            }
        });
        // Volume slider live feedback
        const volumeSlider = document.getElementById('simt-s-volume');
        const volumePct = document.getElementById('simt-volume-pct');
        volumeSlider.addEventListener('input', () => {
            volumePct.textContent = volumeSlider.value + '%';
        });
    }
    function openSettingsPanel() {
        // Pause auto-refresh while settings are open
        if (isAutoRefreshRunning) {
            settingsPanelWasOpen = true;
            pauseAutoRefresh();
        }
        let panel = document.getElementById('simt-settings-panel');
        if (!panel) createSettingsPanel();
        requestAnimationFrame(() => {
            document.getElementById('simt-settings-overlay').classList.add('open');
            document.getElementById('simt-settings-panel').classList.add('open');
        });
    }
    let settingsPanelWasOpen = false;
    function closeSettingsPanel() {
        const panel = document.getElementById('simt-settings-panel');
        const overlay = document.getElementById('simt-settings-overlay');
        if (panel) panel.classList.remove('open');
        if (overlay) overlay.classList.remove('open');
        // Remove overlay from DOM after transition to prevent click-blocking
        setTimeout(() => {
            const o = document.getElementById('simt-settings-overlay');
            if (o && !o.classList.contains('open')) o.remove();
            const p = document.getElementById('simt-settings-panel');
            if (p && !p.classList.contains('open')) p.remove();
        }, 350);
        // Resume auto-refresh from where it left off
        if (settingsPanelWasOpen && CONFIG.autoRefreshEnabled) {
            if (secondsRemaining > 0) {
                resumeWithSeconds(secondsRemaining);
            } else {
                startAutoRefresh();
            }
        }
        settingsPanelWasOpen = false;
    }
    async function applyAndSaveSettings() {
        CONFIG.desktopNotifEnabled = document.getElementById('simt-s-desktopNotif').checked;
        CONFIG.soundEnabled = document.getElementById('simt-s-sound').checked;
        CONFIG.notifSound = document.getElementById('simt-s-notifSound').value;
        CONFIG.detectAssigneeChanges = document.getElementById('simt-s-detectAssignee').checked;
        CONFIG.compactBadge = document.getElementById('simt-s-compactBadge').checked;
        CONFIG.inPagePopupEnabled = document.getElementById('simt-s-inPagePopup').checked;
        CONFIG.soundVolume = parseInt(document.getElementById('simt-s-volume').value) / 100;
        CONFIG.notifDurationSec = Math.max(1, Math.min(30, parseInt(document.getElementById('simt-s-notifDur').value) || 8));
        CONFIG.showTicketTitles = document.getElementById('simt-s-showTitles').checked;
        CONFIG.titleMaxLength = Math.max(20, Math.min(120, parseInt(document.getElementById('simt-s-titleMaxLen').value) || 60));
        CONFIG.autoRefreshEnabled = document.getElementById('simt-s-autoRefresh').checked;
        CONFIG.autoRefreshMinutes = Math.max(1, Math.min(60, parseInt(document.getElementById('simt-s-interval').value) || 2));
        CONFIG.scrapeDelay = Math.max(500, Math.min(10000, parseInt(document.getElementById('simt-s-scrapeDelay').value) || 2500));
        CONFIG.ticketRowSelector = document.getElementById('simt-s-selector').value.trim() || DEFAULTS.ticketRowSelector;
        CONFIG.ticketIdAttr = document.getElementById('simt-s-idAttr').value.trim() || DEFAULTS.ticketIdAttr;
        CONFIG.filterAssignees = document.getElementById('simt-s-filterAssignees').value.trim();
        CONFIG.filterSeverities = document.getElementById('simt-s-filterSeverities').value.trim();
        CONFIG.filterTicketTypes = document.getElementById('simt-s-filterTypes').value.trim();
        CONFIG.refreshExcludePatterns = document.getElementById('simt-s-excludePatterns').value.trim() || DEFAULTS.refreshExcludePatterns;
        await saveSettings(CONFIG);
        closeSettingsPanel();
        if (CONFIG.autoRefreshEnabled) { startAutoRefresh(); } else { stopAutoRefresh(); }
        console.log('[T-Pot] Settings saved.', CONFIG);
    }
    async function resetSettings() {
        if (!confirm('Reset all T-Pot settings to defaults?')) return;
        Object.assign(CONFIG, DEFAULTS);
        await saveSettings(CONFIG);
        closeSettingsPanel();
        if (CONFIG.autoRefreshEnabled) { startAutoRefresh(); } else { stopAutoRefresh(); }
        console.log('[T-Pot] Settings reset to defaults.');
    }
    // ──────────────────────────────────────────────
    // AUTO-REFRESH TIMER
    // ──────────────────────────────────────────────
    let autoRefreshTimer = null;
    let countdownTimer = null;
    let secondsRemaining = 0;
    let isAutoRefreshRunning = false;
    // ──────────────────────────────────────────────
    // PAGE DETECTION — only auto-refresh on list pages
    // ──────────────────────────────────────────────
    function isTicketListPage() {
        const path = window.location.pathname;
        // Match /issues or /issues/
        if (/^\/issues\/?$/.test(path)) return true;
        // Match /issues/<something> — check if <something> is a ticket ID
        const match = path.match(/^\/issues\/([^/]+)/);
        if (!match) return true; // no sub-path, it's a list page
        const segment = match[1];
        // Ticket IDs: letter + 7+ digits (e.g. V2349347283, P500063113) or pure 8+ digits.
        // List views use slugs with hyphens (e.g. all-my-groups, assigned-to-me).
        if (/^[A-Za-z]\d{7,}$/.test(segment) || /^\d{8,}$/.test(segment)) return false;
        return true;
    }
    function isRefreshAllowedPage() {
        // Must be a ticket list page first
        if (!isTicketListPage()) return false;
        const url = window.location.href.toLowerCase();
        const patterns = parseCSVFilter(CONFIG.refreshExcludePatterns);
        // If any exclusion pattern matches the current URL, block refresh
        for (const pattern of patterns) {
            if (url.includes(pattern)) {
                return false;
            }
        }
        return true;
    }
    function getPageType() {
        if (!isTicketListPage()) return 'individual-ticket';
        return isRefreshAllowedPage() ? 'ticket-list' : 'excluded';
    }
    // ──────────────────────────────────────────────
    // DYNAMIC BADGE POSITIONING
    // ──────────────────────────────────────────────
    const BADGE_MARGIN = 16;
    function findOccupiedBottomRight() {
        const allEls = document.querySelectorAll('body > *');
        let maxTop = 0;
        allEls.forEach(el => {
            if (el.id === 'simt-notifier-badge' ||
                el.id === 'simt-settings-panel' ||
                el.id === 'simt-settings-overlay') return;
            const style = window.getComputedStyle(el);
            if (style.position !== 'fixed' && style.position !== 'sticky') return;
            const rect = el.getBoundingClientRect();
            const viewW = window.innerWidth;
            const viewH = window.innerHeight;
            if (rect.right > viewW * 0.5 && rect.bottom > viewH * 0.5) {
                const occupiedFromBottom = viewH - rect.top;
                if (occupiedFromBottom > maxTop) maxTop = occupiedFromBottom;
            }
        });
        return maxTop;
    }
    function createControlBadge() {
        // Remove any existing badge to prevent duplicates
        const existing = document.getElementById('simt-notifier-badge');
        if (existing) existing.remove();
        const offsetBottom = findOccupiedBottomRight();
        const badgeBottom = offsetBottom > 0 ? offsetBottom + BADGE_MARGIN : BADGE_MARGIN;
        const badge = document.createElement('div');
        badge.id = 'simt-notifier-badge';
        badge.style.cssText = `
            position: fixed;
            bottom: ${badgeBottom}px;
            right: 32px;
            z-index: 999999;
            background: #232f3e;
            color: #ff9900;
            font-family: 'Amazon Ember', Arial, sans-serif;
            font-size: 13px;
            font-weight: 600;
            padding: 8px 14px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
            cursor: pointer;
            user-select: none;
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 8px;
            transition: opacity 0.2s;
        `;
        badge.title = 'Click to toggle auto-refresh (Alt+R)';
        const icon = document.createElement('span');
        icon.id = 'simt-badge-icon';
        icon.textContent = '🫖';
        const label = document.createElement('span');
        label.id = 'simt-badge-label';
        label.textContent = 'T-Pot: ON';
        if (CONFIG.compactBadge) label.style.display = 'none';
        const timer = document.createElement('span');
        timer.id = 'simt-badge-timer';
        timer.style.cssText = 'color: #aaa; font-weight: 400; font-size: 12px;';
        timer.textContent = '';
        const settingsBtn = document.createElement('span');
        settingsBtn.textContent = '⚙️';
        settingsBtn.title = 'Open Settings';
        settingsBtn.style.cssText = 'cursor: pointer; margin-left: 4px; font-size: 16px; opacity: 0.7; transition: opacity 0.15s;';
        settingsBtn.addEventListener('mouseenter', () => settingsBtn.style.opacity = '1');
        settingsBtn.addEventListener('mouseleave', () => settingsBtn.style.opacity = '0.7');
        settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openSettingsPanel();
        });
        badge.appendChild(icon);
        badge.appendChild(label);
        badge.appendChild(timer);
        badge.appendChild(settingsBtn);
        document.body.appendChild(badge);
        badge.addEventListener('click', toggleAutoRefresh);
        return badge;
    }
    function repositionBadge() {
        const badge = document.getElementById('simt-notifier-badge');
        if (!badge) return;
        const offsetBottom = findOccupiedBottomRight();
        const badgeBottom = offsetBottom > 0 ? offsetBottom + BADGE_MARGIN : BADGE_MARGIN;
        badge.style.bottom = badgeBottom + 'px';
    }
    let repositionObserver = null;
    function startRepositionWatcher() {
        setTimeout(repositionBadge, 3000);
        setTimeout(repositionBadge, 6000);
        if (typeof MutationObserver !== 'undefined') {
            repositionObserver = new MutationObserver(() => {
                repositionBadge();
            });
            repositionObserver.observe(document.body, {
                childList: true,
                subtree: false,
            });
        }
    }
    function updateBadge(enabled, excludedPage) {
        const label = document.getElementById('simt-badge-label');
        const icon = document.getElementById('simt-badge-icon');
        if (label) label.style.display = CONFIG.compactBadge ? 'none' : '';
        if (excludedPage) {
            if (label) label.textContent = 'T-Pot: PAUSED (non-list page)';
            if (icon) icon.textContent = '📄';
        } else if (enabled) {
            if (label) label.textContent = 'T-Pot: ON';
            if (icon) icon.textContent = '🫖';
        } else {
            if (label) label.textContent = 'T-Pot: OFF';
            if (icon) icon.textContent = '⏸️';
        }
    }
    function updateCountdown() {
        const timer = document.getElementById('simt-badge-timer');
        if (timer && secondsRemaining > 0) {
            const mins = Math.floor(secondsRemaining / 60);
            const secs = secondsRemaining % 60;
            timer.textContent = `(${mins}:${secs.toString().padStart(2, '0')})`;
            secondsRemaining--;
        }
    }
    function startAutoRefresh() {
        pauseAutoRefresh(); // clean up any existing timers
        isAutoRefreshRunning = true;
        // Check if we're on an allowed page
        if (!isRefreshAllowedPage()) {
            console.log('[T-Pot] Auto-refresh skipped — excluded page:', window.location.pathname);
            updateBadge(true, true); // paused due to page
            return;
        }
        // Use full interval for fresh start
        resumeWithSeconds(CONFIG.autoRefreshMinutes * 60);
    }
    function resumeWithSeconds(seconds) {
        // Clear any existing timers first
        clearTimeout(autoRefreshTimer);
        clearInterval(countdownTimer);
        autoRefreshTimer = null;
        countdownTimer = null;
        secondsRemaining = seconds;
        isAutoRefreshRunning = true;
        countdownTimer = setInterval(updateCountdown, 1000);
        autoRefreshTimer = setTimeout(() => {
            if (isRefreshAllowedPage()) {
                console.log('[T-Pot] Auto-refreshing page...');
                location.reload();
            } else {
                console.log('[T-Pot] Refresh cancelled — navigated to excluded page.');
                updateBadge(true, true);
            }
        }, seconds * 1000);
        updateBadge(true, false);
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        console.log(`[T-Pot] Auto-refresh scheduled in ${mins}:${secs.toString().padStart(2, '0')}.`);
    }
    function pauseAutoRefresh() {
        // Stop timers but KEEP secondsRemaining so we can resume
        clearTimeout(autoRefreshTimer);
        clearInterval(countdownTimer);
        autoRefreshTimer = null;
        countdownTimer = null;
        isAutoRefreshRunning = false;
        const timer = document.getElementById('simt-badge-timer');
        if (timer) timer.textContent = '';
        updateBadge(false);
    }
    function stopAutoRefresh() {
        pauseAutoRefresh();
        secondsRemaining = 0; // full reset
    }
    function toggleAutoRefresh() {
        if (isAutoRefreshRunning) {
            pauseAutoRefresh();
            console.log('[T-Pot] Auto-refresh paused.');
        } else {
            if (secondsRemaining > 0) {
                // Resume from where we left off
                console.log(`[T-Pot] Resuming with ${secondsRemaining}s remaining.`);
                resumeWithSeconds(secondsRemaining);
            } else {
                // Fresh start
                startAutoRefresh();
            }
        }
    }
    // Keyboard shortcut: Alt+R to toggle auto-refresh
    document.addEventListener('keydown', (e) => {
        if (e.altKey && e.key.toLowerCase() === 'r') {
            e.preventDefault();
            toggleAutoRefresh();
        }
    });
    // Keyboard shortcut: Alt+S to open settings
    document.addEventListener('keydown', (e) => {
        if (e.altKey && e.key.toLowerCase() === 's') {
            e.preventDefault();
            openSettingsPanel();
        }
    });
    // Register Tampermonkey menu command
    GM_registerMenuCommand('🫖 T-Pot Settings', openSettingsPanel);
    // ──────────────────────────────────────────────
    // INIT — load saved settings, then run
    // ──────────────────────────────────────────────
    (async function init() {
        CONFIG = await loadSettings();
        // One-time migration to v2.29+ URL-keyed storage
        // Clear old storage formats and fix corrupted settings
        const migrationDone = await GM_getValue('tpot_v229_migrated', false);
        if (!migrationDone) {
            console.log('[T-Pot] Running v2.29 migration — clearing old storage...');
            await GM_setValue('simt_known_tickets', '[]');
            await GM_setValue('simt_known_tickets_v2', '{}');
            await GM_setValue('simt_tickets_by_view', '{}');
            // Fix corrupted selector if present
            if (CONFIG.ticketRowSelector && !CONFIG.ticketRowSelector.includes('"item"')) {
                console.log('[T-Pot] Fixing corrupted selector...');
                CONFIG.ticketRowSelector = DEFAULTS.ticketRowSelector;
                await saveSettings(CONFIG);
            }
            await GM_setValue('tpot_v229_migrated', true);
            console.log('[T-Pot] Migration complete.');
        }
        // Badge loads instantly — no waiting for ticket scraping
        createControlBadge();
        startRepositionWatcher();
        if (CONFIG.autoRefreshEnabled) {
            startAutoRefresh();
        }
        // Ticket scraping runs in the background
        main();
    })();
})();
