// ==UserScript==
// @name         T-Pot — SIM-T Ticket Notifier
// @namespace    http://tampermonkey.net/
// @version      1.5
// @updateURL    https://raw.githubusercontent.com/clintzula/t-pot/main/t-pot.user.js
// @downloadURL  https://raw.githubusercontent.com/clintzula/t-pot/main/t-pot.user.js
// @description  Notifies you with a desktop notification and sound when new tickets appear in SIM-T on refresh
// @author       Amazon Quick
// @match        https://t.corp.amazon.com/*
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    'use strict';

    // ──────────────────────────────────────────────
    // DEFAULT CONFIG & SETTINGS PERSISTENCE
    // ──────────────────────────────────────────────
    const DEFAULTS = {
        ticketRowSelector: 'tr.tt-content-tr, tr[data-ticket-id], table.list tbody tr',
        ticketIdAttr: 'data-ticket-id',
        scrapeDelay: 2500,
        soundEnabled: true,
        autoRefreshEnabled: true,
        autoRefreshMinutes: 2,
        desktopNotifEnabled: true,
        notifDurationSec: 8,
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
            playChime();
        } catch (e) {
            console.warn('[T-Pot] Could not play sound:', e);
        }
    }

    function playChime() {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        [520, 660].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.3, ctx.currentTime + i * 0.15);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.4);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(ctx.currentTime + i * 0.15);
            osc.stop(ctx.currentTime + i * 0.15 + 0.4);
        });
    }

    // ──────────────────────────────────────────────
    // TICKET ID EXTRACTION
    // ──────────────────────────────────────────────
    function extractTicketId(row) {
        // 1. Try data attribute
        const attrId = row.getAttribute(CONFIG.ticketIdAttr);
        if (attrId) return attrId.trim();

        // 2. Try first link that looks like a ticket URL
        const link = row.querySelector('a[href*="/issues/"]') || row.querySelector('a[href*="/t.corp"]');
        if (link) {
            const match = link.href.match(/\/issues\/([A-Za-z0-9-]+)/);
            if (match) return match[1];
            return link.href;
        }

        // 3. Try the first cell's text content (often the ticket ID column)
        const firstCell = row.querySelector('td');
        if (firstCell) {
            const text = firstCell.textContent.trim();
            if (text.length > 0 && text.length < 100) return text;
        }

        return null;
    }

    function scrapeCurrentTickets() {
        const rows = document.querySelectorAll(CONFIG.ticketRowSelector);
        const ids = new Set();
        rows.forEach(row => {
            const id = extractTicketId(row);
            if (id) ids.add(id);
        });
        return ids;
    }

    // ──────────────────────────────────────────────
    // DESKTOP NOTIFICATION
    // ──────────────────────────────────────────────
    function requestNotificationPermission() {
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    }

    function showDesktopNotification(newTickets) {
        if (!CONFIG.desktopNotifEnabled) return;
        const count = newTickets.length;
        const title = `🫖 ${count} New Ticket${count > 1 ? 's' : ''} — T-Pot`;
        const body = count <= 5
            ? newTickets.join('\n')
            : newTickets.slice(0, 4).join('\n') + `\n...and ${count - 4} more`;

        if ('Notification' in window && Notification.permission === 'granted') {
            const notif = new Notification(title, {
                body: body,
                icon: 'https://t.corp.amazon.com/favicon.ico',
                tag: 't-pot-new-tickets', // replaces previous notification
                requireInteraction: false,
            });
            // Click the notification to focus the SIM-T tab
            notif.onclick = () => {
                window.focus();
                notif.close();
            };
            // Auto-close after 8 seconds
            setTimeout(() => notif.close(), CONFIG.notifDurationSec * 1000);
        } else {
            // Fallback: use Tampermonkey's built-in notification
            GM_notification({
                title: title,
                text: body,
                timeout: 8000,
            });
        }
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

        // Wait for SIM-T's JS to finish rendering
        await new Promise(resolve => setTimeout(resolve, CONFIG.scrapeDelay));

        const currentTickets = scrapeCurrentTickets();
        if (currentTickets.size === 0) {
            console.log('[T-Pot] No tickets found on page. Selectors may need updating.');
            return;
        }

        const storedTickets = await getStoredTickets();

        // First run — just store, don't alert
        if (storedTickets.size === 0) {
            console.log(`[T-Pot] First run — stored ${currentTickets.size} tickets.`);
            await storeTickets(currentTickets);
            return;
        }

        // Find new tickets (in current but not in stored)
        const newTickets = [...currentTickets].filter(id => !storedTickets.has(id));

        if (newTickets.length > 0) {
            console.log(`[T-Pot] 🆕 ${newTickets.length} new ticket(s):`, newTickets);
            showDesktopNotification(newTickets);
            playNotificationSound();
        } else {
            console.log('[T-Pot] No new tickets since last visit.');
        }

        // Update stored tickets to current state
        await storeTickets(currentTickets);
    }

    // ──────────────────────────────────────────────
    // SETTINGS GUI
    // ──────────────────────────────────────────────
    const PANEL_STYLES = `
        #simt-settings-overlay {
            position: fixed; inset: 0; z-index: 9999998;
            background: rgba(0,0,0,0.45); opacity: 0;
            transition: opacity 0.25s ease;
        }
        #simt-settings-overlay.open { opacity: 1; }

        #simt-settings-panel {
            position: fixed; top: 0; right: -420px; bottom: 0; z-index: 9999999;
            width: 400px; max-width: 95vw;
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
    `;

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = PANEL_STYLES;
        document.head.appendChild(style);
    }

    function createSettingsPanel() {
        injectStyles();

        // Overlay
        const overlay = document.createElement('div');
        overlay.id = 'simt-settings-overlay';
        overlay.addEventListener('click', closeSettingsPanel);
        document.body.appendChild(overlay);

        // Panel
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
                            <div class="label-desc">Show browser push notifications for new tickets</div>
                        </div>
                        <label class="simt-toggle">
                            <input type="checkbox" id="simt-s-desktopNotif" ${CONFIG.desktopNotifEnabled ? 'checked' : ''}>
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
                            <div class="label-main">Notification Duration</div>
                            <div class="label-desc">Seconds before auto-close (1–30)</div>
                        </div>
                        <input type="number" class="simt-input" id="simt-s-notifDur" min="1" max="30" value="${CONFIG.notifDurationSec}">
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
                </div>
            </div>
            <div class="simt-panel-footer">
                <button class="simt-btn simt-btn-danger" id="simt-reset-btn">Reset Defaults</button>
                <div style="flex:1;"></div>
                <button class="simt-btn simt-btn-secondary" id="simt-cancel-btn">Cancel</button>
                <button class="simt-btn simt-btn-primary" id="simt-save-btn">Save & Apply</button>
            </div>
        `;
        document.body.appendChild(panel);

        // Wire up buttons
        document.getElementById('simt-close-btn').addEventListener('click', closeSettingsPanel);
        document.getElementById('simt-cancel-btn').addEventListener('click', closeSettingsPanel);
        document.getElementById('simt-save-btn').addEventListener('click', applyAndSaveSettings);
        document.getElementById('simt-reset-btn').addEventListener('click', resetSettings);
        document.getElementById('simt-test-sound').addEventListener('click', () => playChime());
    }

    function openSettingsPanel() {
        let panel = document.getElementById('simt-settings-panel');
        if (!panel) createSettingsPanel();
        // Small delay to trigger CSS transition
        requestAnimationFrame(() => {
            document.getElementById('simt-settings-overlay').classList.add('open');
            document.getElementById('simt-settings-panel').classList.add('open');
        });
    }

    function closeSettingsPanel() {
        const panel = document.getElementById('simt-settings-panel');
        const overlay = document.getElementById('simt-settings-overlay');
        if (panel) panel.classList.remove('open');
        if (overlay) overlay.classList.remove('open');
    }

    async function applyAndSaveSettings() {
        CONFIG.desktopNotifEnabled = document.getElementById('simt-s-desktopNotif').checked;
        CONFIG.soundEnabled = document.getElementById('simt-s-sound').checked;
        CONFIG.notifDurationSec = Math.max(1, Math.min(30, parseInt(document.getElementById('simt-s-notifDur').value) || 8));
        CONFIG.autoRefreshEnabled = document.getElementById('simt-s-autoRefresh').checked;
        CONFIG.autoRefreshMinutes = Math.max(1, Math.min(60, parseInt(document.getElementById('simt-s-interval').value) || 2));
        CONFIG.scrapeDelay = Math.max(500, Math.min(10000, parseInt(document.getElementById('simt-s-scrapeDelay').value) || 2500));
        CONFIG.ticketRowSelector = document.getElementById('simt-s-selector').value.trim() || DEFAULTS.ticketRowSelector;
        CONFIG.ticketIdAttr = document.getElementById('simt-s-idAttr').value.trim() || DEFAULTS.ticketIdAttr;

        await saveSettings(CONFIG);
        closeSettingsPanel();

        // Restart auto-refresh with new interval
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
    // DYNAMIC BADGE POSITIONING
    // Detects other fixed-position widgets in the bottom-right
    // corner and stacks T-Pot above them to avoid overlap.
    // ──────────────────────────────────────────────
    const BADGE_MARGIN = 16;  // px from edge & between badges
    const BADGE_CORNER = 'bottom-right';

    function findOccupiedBottomRight() {
        // Find all fixed/sticky elements near the bottom-right corner
        // that are NOT ours
        const allEls = document.querySelectorAll('body > *');
        let maxTop = 0; // highest occupied bottom-px from viewport bottom
        allEls.forEach(el => {
            if (el.id === 'simt-notifier-badge' ||
                el.id === 'simt-settings-panel' ||
                el.id === 'simt-settings-overlay') return;
            const style = window.getComputedStyle(el);
            if (style.position !== 'fixed' && style.position !== 'sticky') return;
            const rect = el.getBoundingClientRect();
            const viewW = window.innerWidth;
            const viewH = window.innerHeight;
            // Check if it's in the bottom-right quadrant
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
            e.stopPropagation(); // Don't toggle auto-refresh
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

    // Re-check position periodically in case other widgets load late
    function repositionBadge() {
        const badge = document.getElementById('simt-notifier-badge');
        if (!badge) return;
        const offsetBottom = findOccupiedBottomRight();
        const badgeBottom = offsetBottom > 0 ? offsetBottom + BADGE_MARGIN : BADGE_MARGIN;
        badge.style.bottom = badgeBottom + 'px';
    }

    // Watch for new fixed elements appearing (other TM scripts loading later)
    let repositionObserver = null;
    function startRepositionWatcher() {
        // Check once after a delay for late-loading scripts
        setTimeout(repositionBadge, 3000);
        setTimeout(repositionBadge, 6000);

        // Also use MutationObserver on body for dynamically added elements
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

    function updateBadge(enabled) {
        const label = document.getElementById('simt-badge-label');
        const icon = document.getElementById('simt-badge-icon');
        if (label) label.textContent = enabled ? 'T-Pot: ON' : 'T-Pot: OFF';
        if (icon) icon.textContent = enabled ? '🫖' : '⏸️';
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
        const intervalMs = CONFIG.autoRefreshMinutes * 60 * 1000;
        secondsRemaining = CONFIG.autoRefreshMinutes * 60;

        countdownTimer = setInterval(updateCountdown, 1000);
        autoRefreshTimer = setTimeout(() => {
            console.log('[T-Pot] Auto-refreshing page...');
            location.reload();
        }, intervalMs);

        updateBadge(true);
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

    // Keyboard shortcut: Alt+R
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
