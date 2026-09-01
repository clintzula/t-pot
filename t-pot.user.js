// ==UserScript==
// @name         T-Pot — SIM-T Ticket Notifier
// @namespace    http://tampermonkey.net/
// @version      2.12
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
 *  A Tampermonkey userscript that watches your SIM-T queue
 *  for new tickets and alerts you with desktop notifications
 *  and sound. Supports auto-refresh, volume control, and
 *  filtering by assignee, severity, and ticket type.
 *
 *  CHANGELOG
 *  ─────────
 *  v2.12 — 2026-09-01
 *    • Fixed CSS selectors to match SIM-T's AWS UI markup
 *    • Ticket ID extraction now reads V-prefix IDs from cell text
 *    • Updated filter descriptions and placeholders to match actual SIM-T values
 *    • Severity filter now matches numbers (1, 2, 3) not SEV-1 format
 *    • Assignee filter matches usernames as displayed on page
 *    • Renamed Ticket Type filter to Keywords / Ticket Type
 *
 *  v2.1 — 2026-09-01
 *    • Fixed: clicking not working after closing settings (overlay removed from DOM)
 *    • Timer now pauses while settings panel is open and resumes on close
 *    • Separate toggles for desktop notifications and in-page popup
 *    • Auto-refresh only runs on ticket list pages (not individual tickets)
 *    • Badge moved to bottom-right with 16px offset
 *    • Test button triggers all enabled notifications (sound, desktop, popup)
 *
 *  v2.0 — 2026-09-01
 *    • Desktop notifications with configurable duration
 *    • Sound alerts with volume control slider and live preview
 *    • In-page popup toast with clickable ticket links
 *    • Auto-refresh timer with countdown badge and Alt+R toggle
 *    • Auto-refresh pauses on excluded pages (create, edit, bulk)
 *    • Script only runs on /issues pages by default
 *    • Additional pages can be added in settings
 *    • Filters: assignee, severity, and ticket type
 *    • Settings GUI panel (slide-out with toggles, sliders, inputs)
 *    • Alt+S shortcut and Tampermonkey menu command for settings
 *    • GitHub auto-update via @updateURL / @downloadURL
 *    • Dynamic badge positioning to avoid other widgets
 *    • Control badge on bottom-left with status and countdown
 *    • Rebranded to T-Pot with 🫖 teapot emoji
 *    • Author signature in header and settings panel
 *    • Stores known tickets in Tampermonkey storage
 *    • First-run baseline (no false alarm on first load)
 ************************************************************/

(function () {
    'use strict';

    // ──────────────────────────────────────────────
    // DEFAULT CONFIG & SETTINGS PERSISTENCE
    // ──────────────────────────────────────────────
    const DEFAULTS = {
        ticketRowSelector: 'tbody tr[data-selection-item="item"]',
        ticketIdAttr: 'data-ticket-id',
        scrapeDelay: 2500,
        soundEnabled: true,
        soundVolume: 0.3,           // 0.0 – 1.0
        autoRefreshEnabled: true,
        autoRefreshMinutes: 2,
        desktopNotifEnabled: true,
        inPagePopupEnabled: true,     // in-page popup toast
        notifDurationSec: 8,
        // Filters — blank = notify for ALL
        filterAssignees: '',        // comma-separated aliases as shown on page, e.g. "alexyano, mdanju"
        filterSeverities: '',       // comma-separated severity numbers as shown, e.g. "1, 2, 3"
        filterTicketTypes: '',      // comma-separated, matches row text, e.g. "Boost, Pending"
        // Auto-refresh page exclusions — refresh is skipped on URLs matching these patterns
        refreshExcludePatterns: '/create, /edit, /bulk',
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
            playChime(CONFIG.soundVolume);
        } catch (e) {
            console.warn('[T-Pot] Could not play sound:', e);
        }
    }

    function playChime(volume) {
        const vol = Math.max(0, Math.min(1, volume ?? CONFIG.soundVolume));
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

    // ──────────────────────────────────────────────
    // TICKET DATA EXTRACTION
    // ──────────────────────────────────────────────
    function extractTicketId(row) {
        // 1. Try data attribute (if configured)
        const attrId = row.getAttribute(CONFIG.ticketIdAttr);
        if (attrId) return attrId.trim();

        // 2. Search all cells for a SIM-T ticket ID pattern (e.g. V2349367928)
        const cells = row.querySelectorAll('td');
        for (const cell of cells) {
            const text = cell.textContent.trim();
            // SIM-T ticket IDs: V + digits, or pure long numeric IDs
            const match = text.match(/\b(V\d{5,}|\d{8,})\b/);
            if (match) return match[1];
        }

        // 3. Try links containing /issues/
        const link = row.querySelector('a[href*="/issues/"]') || row.querySelector('a[href*="/t.corp"]');
        if (link) {
            const match = link.href.match(/\/issues\/([A-Za-z0-9-]+)/);
            if (match) return match[1];
        }

        return null;
    }

    function extractRowText(row) {
        // Returns the full text content of the row for filter matching
        return (row.textContent || '').toLowerCase();
    }

    function scrapeCurrentTickets() {
        const rows = document.querySelectorAll(CONFIG.ticketRowSelector);
        const tickets = []; // {id, rowText}
        rows.forEach(row => {
            // Skip category header rows
            if (row.classList.contains('category-label')) return;
            const id = extractTicketId(row);
            if (id) {
                tickets.push({ id, rowText: extractRowText(row) });
            }
        });
        return tickets;
    }

    // ──────────────────────────────────────────────
    // TICKET FILTERING
    // ──────────────────────────────────────────────
    function parseCSVFilter(str) {
        if (!str || !str.trim()) return [];
        return str.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
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
        if (severities.length > 0 && !severities.some(s => text.includes(s))) return false;
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

    function showDesktopNotification(newTicketIds) {
        if (!CONFIG.desktopNotifEnabled) return;
        const count = newTicketIds.length;
        const title = `🫖 ${count} New Ticket${count > 1 ? 's' : ''} — T-Pot`;
        const body = count <= 5
            ? newTicketIds.join('\n')
            : newTicketIds.slice(0, 4).join('\n') + `\n...and ${count - 4} more`;

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
    function showInPagePopup(ticketIds) {
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

        const count = ticketIds.length;

        popup.innerHTML = `
            <div style="
                display: flex; align-items: center; justify-content: space-between;
                padding: 12px 16px; background: #16213e; border-bottom: 1px solid #333;
            ">
                <div style="font-size: 15px; font-weight: 700; color: #ff9900;">
                    🫖 ${count} New Ticket${count > 1 ? 's' : ''}
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
                ${ticketIds.map(id => `
                    <a href="https://t.corp.amazon.com/issues/${encodeURIComponent(id)}"
                       target="_blank"
                       style="
                           display: flex; align-items: center; gap: 10px;
                           padding: 10px 16px; color: #e0e0e0; text-decoration: none;
                           font-size: 14px; transition: background 0.15s;
                           border-bottom: 1px solid rgba(255,255,255,0.05);
                       "
                       onmouseenter="this.style.background='#2a2a3e'"
                       onmouseleave="this.style.background='transparent'">
                        <span style="font-size: 18px;">🎫</span>
                        <span style="flex:1; font-weight: 600;">${id}</span>
                        <span style="color: #ff9900; font-size: 12px;">Open →</span>
                    </a>
                `).join('')}
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
    // STORAGE (Tampermonkey cross-page persistence)
    // ──────────────────────────────────────────────
    const STORAGE_KEY = 'simt_known_tickets';

    async function getStoredTickets() {
        const raw = await GM_getValue(STORAGE_KEY, '[]');
        try {
            return new Set(JSON.parse(raw));
        } catch {
            return new Set();
        }
    }

    async function storeTickets(ticketSet) {
        await GM_setValue(STORAGE_KEY, JSON.stringify([...ticketSet]));
    }

    // ──────────────────────────────────────────────
    // MAIN LOGIC
    // ──────────────────────────────────────────────
    async function main() {
        requestNotificationPermission();

        await new Promise(resolve => setTimeout(resolve, CONFIG.scrapeDelay));

        const allTickets = scrapeCurrentTickets();
        const allIds = new Set(allTickets.map(t => t.id));

        if (allIds.size === 0) {
            console.log('[T-Pot] No tickets found on page. Selectors may need updating.');
            return;
        }

        const storedTickets = await getStoredTickets();

        // First run — just store, don't alert
        if (storedTickets.size === 0) {
            console.log(`[T-Pot] First run — stored ${allIds.size} tickets.`);
            await storeTickets(allIds);
            return;
        }

        // Find new tickets (in current but not in stored)
        const newTickets = allTickets.filter(t => !storedTickets.has(t.id));

        if (newTickets.length > 0) {
            // Apply filters
            const matchingTickets = newTickets.filter(ticketMatchesFilters);

            if (matchingTickets.length > 0) {
                const matchingIds = matchingTickets.map(t => t.id);
                console.log(`[T-Pot] 🆕 ${matchingIds.length} new ticket(s) matched filters:`, matchingIds);
                showDesktopNotification(matchingIds);
                showInPagePopup(matchingIds);
                playNotificationSound();
            } else {
                console.log(`[T-Pot] ${newTickets.length} new ticket(s) found but none matched filters.`);
            }
        } else {
            console.log('[T-Pot] No new tickets since last visit.');
        }

        // Update stored tickets to current state
        await storeTickets(allIds);
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
            position: fixed; top: 0; right: -440px; bottom: 0; z-index: 9999999;
            width: 420px; max-width: 95vw;
            background: #1a1a2e; color: #e0e0e0;
            font-family: 'Amazon Ember', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 14px; box-shadow: -4px 0 24px rgba(0,0,0,0.5);
            display: flex; flex-direction: column;
            transition: right 0.3s ease;
            border-left: 3px solid #ff9900;
        }
        #simt-settings-panel.open { right: 0; }

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

        .simt-panel-body { flex: 1; overflow-y: auto; padding: 16px 20px; }

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
                </div>

                <!-- FILTERS SECTION -->
                <div class="simt-section">
                    <div class="simt-section-title">Filters</div>
                    <p style="font-size:12px; color:#888; margin:0 0 12px;">
                        Only notify when new tickets match <strong>all</strong> non-empty filters below.
                        Leave a field blank to skip that filter. Separate multiple values with commas.
                    </p>
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

                <!-- ADVANCED SECTION -->
                <div class="simt-section">
                    <div class="simt-section-title">Advanced</div>
                    <div class="simt-setting-row">
                        <div class="simt-setting-label">
                            <div class="label-main">Scrape Delay (ms)</div>
                            <div class="label-desc">Wait time for SIM-T to render before reading tickets</div>
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
                🫖 T-Pot v2.12 — Created by
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
            playChime(vol);

            // Also show desktop notification + in-page popup if their toggles are on
            const testTickets = ['TEST-1234'];
            if (document.getElementById('simt-s-desktopNotif').checked) {
                showDesktopNotification(testTickets);
            }
            if (document.getElementById('simt-s-inPagePopup').checked) {
                // Temporarily enable to bypass config check during test
                const origPopup = CONFIG.inPagePopupEnabled;
                CONFIG.inPagePopupEnabled = true;
                showInPagePopup(testTickets);
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
        if (autoRefreshTimer) {
            settingsPanelWasOpen = true;
            stopAutoRefresh();
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

        // Resume auto-refresh if it was running before settings opened
        if (settingsPanelWasOpen && CONFIG.autoRefreshEnabled) {
            startAutoRefresh();
        }
        settingsPanelWasOpen = false;
    }

    async function applyAndSaveSettings() {
        CONFIG.desktopNotifEnabled = document.getElementById('simt-s-desktopNotif').checked;
        CONFIG.soundEnabled = document.getElementById('simt-s-sound').checked;
        CONFIG.inPagePopupEnabled = document.getElementById('simt-s-inPagePopup').checked;
        CONFIG.soundVolume = parseInt(document.getElementById('simt-s-volume').value) / 100;
        CONFIG.notifDurationSec = Math.max(1, Math.min(30, parseInt(document.getElementById('simt-s-notifDur').value) || 8));
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

    // ──────────────────────────────────────────────
    // PAGE DETECTION — only auto-refresh on list pages
    // ──────────────────────────────────────────────
    function isTicketListPage() {
        const path = window.location.pathname;
        // List pages:  /issues, /issues/, /issues/all-my-groups,
        //              /issues/assigned-to-me, /issues/search, etc.
        // Individual tickets look like: /issues/V2349347283 or /issues/12345678
        //   (alphanumeric ID, typically starting with a letter or pure digits)
        //
        // Strategy: if the segment after /issues/ looks like a ticket ID
        // (all alphanumeric, no hyphens), it's an individual ticket page.
        // Otherwise it's a list/filter/search view.

        // Match /issues or /issues/
        if (/^\/issues\/?$/.test(path)) return true;

        // Match /issues/<something> — check if <something> is a ticket ID
        const match = path.match(/^\/issues\/([^/]+)/);
        if (!match) return true; // no sub-path, it's a list page
        const segment = match[1];
        // Ticket IDs are purely alphanumeric (e.g. V2349347283, 12345678)
        // List views use slugs with hyphens (e.g. all-my-groups, assigned-to-me)
        if (/^[A-Za-z0-9]+$/.test(segment) && /\d/.test(segment)) return false;
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
        const offsetBottom = findOccupiedBottomRight();
        const badgeBottom = offsetBottom > 0 ? offsetBottom + BADGE_MARGIN : BADGE_MARGIN;

        const badge = document.createElement('div');
        badge.id = 'simt-notifier-badge';
        badge.style.cssText = `
            position: fixed;
            bottom: ${badgeBottom}px;
            right: 16px;
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
        stopAutoRefresh();

        // Check if we're on an allowed page
        if (!isRefreshAllowedPage()) {
            console.log('[T-Pot] Auto-refresh skipped — excluded page:', window.location.pathname);
            updateBadge(true, true); // paused due to page
            return;
        }

        const intervalMs = CONFIG.autoRefreshMinutes * 60 * 1000;
        secondsRemaining = CONFIG.autoRefreshMinutes * 60;

        countdownTimer = setInterval(updateCountdown, 1000);
        autoRefreshTimer = setTimeout(() => {
            if (isRefreshAllowedPage()) {
                console.log('[T-Pot] Auto-refreshing page...');
                location.reload();
            } else {
                console.log('[T-Pot] Refresh cancelled — navigated to excluded page.');
                updateBadge(true, true);
            }
        }, intervalMs);

        updateBadge(true, false);
        console.log(`[T-Pot] Auto-refresh scheduled in ${CONFIG.autoRefreshMinutes} min.`);
    }

    function stopAutoRefresh() {
        if (autoRefreshTimer) { clearTimeout(autoRefreshTimer); autoRefreshTimer = null; }
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
        const timer = document.getElementById('simt-badge-timer');
        if (timer) timer.textContent = '';
        updateBadge(false);
    }

    function toggleAutoRefresh() {
        if (autoRefreshTimer) {
            stopAutoRefresh();
            console.log('[T-Pot] Auto-refresh paused.');
        } else {
            startAutoRefresh();
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
        main();

        setTimeout(() => {
            createControlBadge();
            startRepositionWatcher();
            if (CONFIG.autoRefreshEnabled) {
                startAutoRefresh();
            }
        }, CONFIG.scrapeDelay + 500);
    })();

})();
