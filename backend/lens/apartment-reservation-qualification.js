import { createRequire } from 'node:module';
import { LensError } from './errors.js';
import { observeInvestorFunding } from './agreement-decision.js';
import { client } from '../property-offers/onchain.js';

const require = createRequire(import.meta.url);
const record = require('../../frontend/js/agreement-record.js');
const pledge = require('../../frontend/js/solana/pledge-client.js').configure({ web3: require('@solana/web3.js') });

export async function planApartmentReservationQualification({ agreement, unitId, buyer, lensKey, nowSeconds, chain }) {
    const { content, funding, observed } = await observeInvestorFunding({ agreement, lensKey, nowSeconds, chain });
    if (buyer === content.sponsor) throw new LensError(422, 'invalid_counterparty', 'Choose a buyer other than the developer.');
    const unit = funding.apartments?.units.find(u => u.unitId === unitId);
    if (!unit) throw new LensError(422, 'unknown_unit', 'Choose an apartment in the published agreement.');
    const listing = observed.reservations?.find(row => row.unitId === unitId);
    if (listing?.status !== 'available') throw new LensError(409, 'unit_unavailable', 'The apartment must be listed and available.');
    const termsHash = record.apartmentTermsHash(funding, unit);
    const unitKey = record.apartmentUnitKey(funding.apartments.projectId, unitId);
    const account = pledge.getApartmentUnitPda(content.sponsor, unitKey)[0].toBase58();
    if (listing.account !== account || listing.termsHash !== termsHash || listing.deposit !== unit.depositUsdcAtomic)
        throw new LensError(422, 'terms_mismatch', 'The listing differs from the published apartment terms.');
    const payoutsHash = Buffer.from(client.payoutScheduleHash([{ recipient: observed.vault, amount: unit.depositUsdcAtomic }])).toString('hex');
    return { cid: agreement.cid, offer: account, termsHash, payoutsHash, buyer, seller: content.sponsor };
}
