const database = new Promise((resolve, reject) => {
  const request = indexedDB.open('autokatastar-review-v1', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('data');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
export async function readState() {
  const db = await database;
  return new Promise((resolve, reject) => {
    const request = db.transaction('data').objectStore('data').get('state');
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}
// Read and update in one transaction, so two tabs cannot lose each other's persisted updates.
export async function updateState(transform) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('data', 'readwrite');
    const store = tx.objectStore('data');
    let next;
    const request = store.get('state');
    request.onsuccess = () => {
      try { next = transform(request.result || null); store.put(next, 'state'); }
      catch (error) { reject(error); tx.abort(); }
    };
    tx.oncomplete = () => resolve(next);
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('Could not save on this device'));
  });
}
