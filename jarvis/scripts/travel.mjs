import { validListingId } from '../core/runtime.mjs';
import { openStore } from '../core/open-store.mjs';
import { createTravelService } from '../core/travel.mjs';
import { isDelftListing } from '../lib/server/listings-data.ts';
import { travelDetail } from '../lib/server/listing-travel.ts';

const [id, ...rest] = process.argv.slice(2);
if (!validListingId(id) || rest.length) {
  console.error('Usage: npm run travel -- <listingId>');
  process.exitCode = 1;
} else {
  let store;
  try {
    store = await openStore({ existing: true });
    const listing = await store?.getListing(id);
    if (!isDelftListing(listing)) {
      console.error('Delft listing not found.');
      process.exitCode = 1;
    } else {
      const service = createTravelService(store);
      const result = await service.check(listing, {});
      console.log(JSON.stringify(travelDetail(result), null, 2));
    }
  } catch (error) {
    if (error?.status === 503) console.error('The address provider is temporarily unavailable.');
    else if (error?.status === 422) console.error('The provider could not resolve the listing address.');
    else console.error('Travel check failed. Check the database configuration and permissions.');
    process.exitCode = 1;
  } finally {
    await store?.close();
  }
}
