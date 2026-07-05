const { EVENT_TTL_MS, BATCH_TTL_MS, BATCH_HISTORY_BUTTON_THRESHOLD, GUEST_LOOKUP_TTL_MS } = require('../config');
const { loadGuestLookupAcrossRoles } = require('../repositories/sheetRepository');

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

async function getCachedGuestLookup() {
    const now = Date.now();
    if (cachedGuestLookup.data && now - cachedGuestLookup.timestamp < GUEST_LOOKUP_TTL_MS) {
        return cachedGuestLookup.data;
    }
    cachedGuestLookup.data = await loadGuestLookupAcrossRoles();
    cachedGuestLookup.timestamp = now;
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
};
