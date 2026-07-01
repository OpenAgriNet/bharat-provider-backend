type BecknBody = {
  context?: { domain?: string; action?: string };
  message?: {
    intent?: {
      category?: { descriptor?: { code?: string; name?: string } };
      item?: { descriptor?: { code?: string; name?: string }; id?: string };
      provider?: { id?: string };
      items?: Array<{ id?: string }>;
    };
    order?: {
      provider?: { id?: string };
      items?: Array<{ id?: string }>;
    };
  };
};

const ROUTE_TO_SERVICE: Record<string, string> = {
  'knowledge-advisory': 'advisory',
  'weather-forecast': 'imd',
  'weather-forecast-mausamgram': 'imd',
  'schemes-agri': 'scheme',
  'icar-schemes': 'scheme',
  mandi: 'mandi',
  'mandi-location': 'mandi',
  pmfby: 'pmfby',
  'grievance-agri': 'grievance',
  'gfr-crop-registry': 'gfr',
  'gfr-crop-recommendation': 'gfr',
  smam: 'smam',
  'sathi-seed': 'sathi',
  'pmkisan-greviance': 'pmkisan',
  'pmfby-grievance': 'pmfby',
  'pmfby-agri': 'pmfby',
  'shc-discovery': 'shc',
};

const ROUTE_NAME_BY_SERVICE: Record<string, string> = {
  scheme: 'schemes-agri',
  mandi: 'price-discovery',
  imd: 'weather-forecast',
  advisory: 'knowledge-advisory',
  pmfby: 'pmfby',
  gfr: 'gfr-agri',
  smam: 'smam',
  sathi: 'sathi-seed',
  shc: 'shc-discovery',
  grievance: 'grievance-agri',
  pmkisan: 'pmkisan-greviance',
};

function resolveMobilityRoute(body: BecknBody): string {
  const categoryName = body?.message?.intent?.category?.descriptor?.name;
  const categoryCode =
    body?.message?.intent?.category?.descriptor?.code?.toLowerCase();
  const categoryNameLower = categoryName?.toLowerCase();
  const firstItemId =
    body?.message?.order?.items?.[0]?.id ??
    body?.message?.intent?.items?.[0]?.id ??
    body?.message?.intent?.item?.id;
  const providerId = (
    body?.message?.order?.provider?.id ??
    body?.message?.intent?.provider?.id ??
    ''
  ).toLowerCase();
  const itemDescriptorCode =
    body?.message?.intent?.item?.descriptor?.code?.toLowerCase();
  const itemDescriptorName = body?.message?.intent?.item?.descriptor?.name;

  switch (true) {
    case categoryName === 'knowledge-advisory':
      return 'knowledge-advisory';
    case categoryName === 'Weather-Forecast':
      return 'weather-forecast';
    case categoryName === 'Weather-Forecast-Mausamgram':
      return 'weather-forecast-mausamgram';
    case categoryCode === 'schemes-agri' || categoryNameLower === 'schemes-agri':
      return 'schemes-agri';
    case categoryCode === 'icar-schemes' || categoryNameLower === 'icar-schemes':
      return 'icar-schemes';
    case categoryCode === 'pmfby' ||
      categoryNameLower === 'pmfby' ||
      !!categoryCode?.startsWith('pmfby') ||
      providerId === 'pmfby-grievance' ||
      firstItemId === 'pmfby-grievance':
      return 'pmfby';
    case categoryCode === 'grievance' || categoryNameLower === 'grievance-agri':
      return 'grievance-agri';
    case providerId === 'gfr-agri':
      return firstItemId === 'gfr-agri-crop-recommendation'
        ? 'gfr-crop-recommendation'
        : 'gfr-crop-registry';
    case categoryCode === 'price-discovery':
      if (itemDescriptorCode === 'mandi') return 'mandi';
      if (itemDescriptorName) return 'mandi-location';
      return 'mandi-location';
    case providerId === 'sathi-seed':
      return 'sathi-seed';
    case providerId === 'smam':
      return 'smam';
    case providerId === 'pmkisan-greviance':
      return 'pmkisan-greviance';
    case providerId === 'pmfby-grievance':
      return 'pmfby-grievance';
    case providerId === 'pmfby-agri':
      return 'pmfby-agri';
    case providerId === 'shc-discovery':
      return 'shc-discovery';
    default:
      return 'unknown';
  }
}

export function resolveServiceName(
  body?: BecknBody,
  requestPath?: string,
): string {
  const route = body ? resolveMobilityRoute(body) : 'unknown';
  if (route !== 'unknown' && ROUTE_TO_SERVICE[route]) {
    return ROUTE_TO_SERVICE[route];
  }

  const domain = body?.context?.domain?.toLowerCase() ?? '';
  if (domain.includes('vistaar')) {
    if (domain.includes('weather')) return 'imd';
    if (domain.includes('advisory')) return 'advisory';
    if (domain.includes('price')) return 'mandi';
    return 'scheme';
  }

  if (requestPath?.includes('/mobility/')) return 'mobility';
  if (requestPath?.includes('/dsep/')) return 'scheme';

  return 'unknown';
}

export function resolveRouteName(
  body?: BecknBody,
  serviceName?: string,
): string {
  const route = body ? resolveMobilityRoute(body) : 'unknown';
  if (route !== 'unknown') return route;
  if (serviceName && ROUTE_NAME_BY_SERVICE[serviceName]) {
    return ROUTE_NAME_BY_SERVICE[serviceName];
  }
  return 'unknown';
}

export function resolveExternalServiceName(url?: string): string {
  if (!url) return 'external';
  const normalized = url.toLowerCase();

  if (normalized.includes('hasura') || normalized.includes('/graphql')) {
    return 'hasura';
  }
  if (normalized.includes('agmarknet')) return 'mandi';
  if (normalized.includes('pmkisan')) return 'pmkisan';
  if (normalized.includes('pmfby')) return 'pmfby';
  if (normalized.includes('mausamgram') || normalized.includes('imd.gov')) {
    return 'imd';
  }
  if (normalized.includes('soilhealth') || normalized.includes('shc')) {
    return 'shc';
  }
  if (normalized.includes('seedtrace') || normalized.includes('sathi')) {
    return 'sathi';
  }
  if (normalized.includes('agrimachinery') || normalized.includes('smam')) {
    return 'smam';
  }

  return 'external';
}

export function extractUseCaseMetadata(body?: Record<string, unknown>): Record<string, string> {
  if (!body) return {};

  const message = (body.message ?? {}) as Record<string, unknown>;
  const intent = (message.intent ?? {}) as Record<string, unknown>;
  const order = (message.order ?? {}) as Record<string, unknown>;
  const category = (intent.category as Record<string, unknown>)?.descriptor as
    | Record<string, string>
    | undefined;
  const item = (intent.item as Record<string, unknown>)?.descriptor as
    | Record<string, string>
    | undefined;
  const provider = ((order.provider ?? intent.provider) as Record<string, unknown>)
    ?.id as string | undefined;

  const meta: Record<string, string> = {};
  if (category?.code) meta.category_code = category.code;
  if (category?.name) meta.category_name = category.name;
  if (item?.name) meta.item_name = item.name;
  if (item?.code) meta.item_code = item.code;
  if (provider) meta.provider_id = provider;

  if (meta.category_code === 'schemes-agri' || meta.category_code === 'icar-schemes') {
    meta.scheme_id = item?.name ?? item?.code ?? '';
  }

  return Object.fromEntries(
    Object.entries(meta).filter(([, value]) => value !== undefined && value !== ''),
  );
}