const PROVIDER_ID = 'ppio';

function createRuntime({ adapter }) {
  async function handleRequest(req, url) {
    const base = `/api/providers/${PROVIDER_ID}`;
    if (req.method === 'GET' && url.pathname === `${base}/regional-inventory`) {
      return {
        status: 200,
        data: {
          offers: await adapter.listOffersWithRegions(url.searchParams.get('refresh') === '1'),
          updatedAt: new Date().toISOString(),
        },
      };
    }
    const regions = url.pathname.match(new RegExp(`^${base}/products/([^/]+)/regions$`));
    if (req.method === 'GET' && regions) {
      return {
        status: 200,
        data: { regions: await adapter.listRegionalOffers(decodeURIComponent(regions[1])) },
      };
    }
    return null;
  }
  return { restore() {}, handleRequest };
}

module.exports = { createRuntime };
