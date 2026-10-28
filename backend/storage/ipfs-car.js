import { CarWriter } from '@ipld/car';
import { importer } from 'ipfs-unixfs-importer';
import { fixedSize } from 'ipfs-unixfs-importer/chunker';
import { balanced } from 'ipfs-unixfs-importer/layout';
import { CHUNK_BYTES } from '../lib/ipfs-file-cid-entry.mjs';
import { cidOf } from '../cid.js';

// Retain the application's chunking, wrapping and CID version across providers.
export async function createFileCar(bytes) {
    const blocks = new Map();
    let root;
    for await (const entry of importer([{ content: bytes }], {
        put: async (cid, block) => { blocks.set(cid.toString(), { cid, bytes: block }); }
    }, {
        cidVersion: 1, rawLeaves: true, reduceSingleLeafToSelf: true,
        wrapWithDirectory: false, chunker: fixedSize({ chunkSize: CHUNK_BYTES }), layout: balanced()
    })) root = entry.cid;
    if (!root || root.toString() !== cidOf(bytes)) throw new Error('CAR root does not match the publication CID.');
    const { writer, out } = CarWriter.create([root]);
    const collected = (async () => {
        const chunks = [];
        for await (const chunk of out) chunks.push(Buffer.from(chunk));
        return Buffer.concat(chunks);
    })();
    for (const block of blocks.values()) await writer.put(block);
    await writer.close();
    return { cid: root.toString(), bytes: await collected };
}
