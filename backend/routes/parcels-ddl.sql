-- Indexes for parcel ownership lookups served from parcel_info
-- These support the latest-version logical parcel-key access pattern:
--   (maticni_broj_ko, broj_cestice) -> latest details payload

CREATE INDEX IF NOT EXISTS parcel_info_ko_broj_version_details_idx
    ON public.parcel_info USING btree (maticni_broj_ko, broj_cestice, version DESC)
    WHERE (details IS NOT NULL);
