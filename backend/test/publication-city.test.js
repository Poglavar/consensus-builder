// Backend binding preserves the consumer-selected source and metadata, without city lookup.
import { describe, it, expect, vi } from 'vitest';
import { publicationCityOf, computeBinding, parcelActBinding } from '../proposals/binding.js';
const site = {type:'Polygon',coordinates:[[[15.97,45.81],[15.971,45.81],[15.971,45.811],[15.97,45.811],[15.97,45.81]]]};
describe('explicit consumer source contract', () => {
    it('preserves a selected source even when the geometry and consumer label differ', () => {
        expect(publicationCityOf({site, city:'any-consumer', parcelSourceId:'parcel-nyc'}))
            .toEqual({city:'any-consumer', parcelSourceId:'parcel-nyc'});
    });
    it('refuses a missing source before reading any dataset', async () => {
        const db = {query:vi.fn()};
        await expect(computeBinding(db,{site,city:'zagreb'})).rejects.toMatchObject({status:400,code:'invalid-parcel-source'});
        await expect(parcelActBinding(db,['HR-123-1'])).rejects.toMatchObject({status:400,code:'invalid-parcel-source'});
        expect(db.query).not.toHaveBeenCalled();
    });
    it('distinguishes an explicit no-cadastre choice from a missing source', async () => {
        const db = {query:vi.fn()};
        const result = await computeBinding(db,{site,parcelSourceId:'none',city:'arbitrary-consumer'});
        expect(result.binding).toMatchObject({coverage:'none',parcels:[],unknownM2:0});
        expect(result.binding.unsurveyedM2).toBeGreaterThan(0);
        expect(db.query).not.toHaveBeenCalled();
    });
});
