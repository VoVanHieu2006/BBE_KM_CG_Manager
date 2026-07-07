const fs = require('fs');
const path = require('path');
const { EVENT_TTL_MS, BATCH_TTL_MS, BATCH_HISTORY_BUTTON_THRESHOLD } = require('../config');
const { createGuestNode } = require('../utils/guestNodeHelper');

const cacheFilePath = path.join(__dirname, '../guest_cache.json');

const processedMessageIds = new Map();
const pendingBatches = new Map();
const pendingSingleLinks = new Map();
const cachedGuestLookup = { data: null, timestamp: 0 };

function wasMessageProcessed(messageId) {
    cleanupTimedStore(processedMessageIds, EVENT_TTL_MS);
    if (processedMessageIds.has(messageId)) return true;
    processedMessageIds.set(messageId, Date.now());
    return false;
}

function cleanupTimedStore(store, ttlMs) {
    const cutoff = Date.now() - ttlMs;
    for (const [key, timestamp] of store.entries()) {
        if (timestamp < cutoff) store.delete(key);
    }
}

function cleanupTimedStoreByField(store, ttlMs, field) {
    const cutoff = Date.now() - ttlMs;
    for (const [key, value] of store.entries()) {
        if (value[field] < cutoff) store.delete(key);
    }
}

function cleanupPendingBatches() {
    const cutoff = Date.now() - BATCH_TTL_MS;
    for (const [batchId, batch] of pendingBatches.entries()) {
        if (batch.createdAt < cutoff) pendingBatches.delete(batchId);
    }
}

function storePendingBatch(sender_psid, links) {
    cleanupPendingBatches();

    const batchId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    pendingBatches.set(batchId, {
        sender_psid,
        items: links,
        showHistoryShortcut: links.length >= BATCH_HISTORY_BUTTON_THRESHOLD,
        createdAt: Date.now(),
    });

    return batchId;
}

function saveCacheToFile(lookup) {
    try {
        const plainData = {};
        for (const [guestId, guest] of lookup.entries()) {
            plainData[guestId] = guest.raw;
        }
        fs.writeFileSync(cacheFilePath, JSON.stringify(plainData, null, 2), 'utf-8');
    } catch (e) {
        console.error('saveCacheToFile error:', e.message);
    }
}

function loadCacheFromFile() {
    try {
        if (!fs.existsSync(cacheFilePath)) return null;
        const raw = fs.readFileSync(cacheFilePath, 'utf-8');
        const plainData = JSON.parse(raw);
        const lookup = new Map();
        for (const [guestId, data] of Object.entries(plainData)) {
            lookup.set(guestId, createGuestNode(data));
        }
        return lookup;
    } catch (e) {
        console.error('loadCacheFromFile error:', e.message);
        return null;
    }
}

async function syncCacheFromSheets() {
    const { loadGuestLookupAcrossRoles } = require('../repositories/sheetRepository');
    const lookup = await loadGuestLookupAcrossRoles();
    cachedGuestLookup.data = lookup;
    cachedGuestLookup.timestamp = Date.now();
    saveCacheToFile(lookup);
}

async function getCachedGuestLookup() {
    if (cachedGuestLookup.data) {
        return cachedGuestLookup.data;
    }

    const fileCache = loadCacheFromFile();
    if (fileCache) {
        cachedGuestLookup.data = fileCache;
        cachedGuestLookup.timestamp = Date.now();
        return cachedGuestLookup.data;
    }

    await syncCacheFromSheets();
    return cachedGuestLookup.data;
}

module.exports = {
    processedMessageIds,
    pendingBatches,
    pendingSingleLinks,
    cachedGuestLookup,
    wasMessageProcessed,
    cleanupTimedStore,
    cleanupTimedStoreByField,
    cleanupPendingBatches,
    storePendingBatch,
    getCachedGuestLookup,
    saveCacheToFile,
    loadCacheFromFile,
    syncCacheFromSheets,
};
