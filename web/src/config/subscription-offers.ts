import type { TranslationKey } from '../i18n';

export type SubscriptionOffer = {
  id: string;
  name: string;
  descriptionKey: TranslationKey;
  featureKeys: TranslationKey[];
  priceLabel?: string;
  available: boolean;
};

export type SubscriptionPromotion = {
  id: string;
  badge: string;
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
  enabled: boolean;
  startsAt?: string;
  endsAt?: string;
  offerIds?: string[];
};

// Commercial terms stay declarative so a published offer or promotion can be
// added without changing the header component. Checkout remains unavailable
// until a payment provider and final legal terms are configured.
export const subscriptionOffers: SubscriptionOffer[] = [
  {
    id: 'ai-media',
    name: 'AI Media',
    descriptionKey: 'subscription.aiMediaDescription',
    featureKeys: ['subscription.feature.balance', 'subscription.feature.models', 'subscription.feature.history'],
    available: false,
  },
];

export const subscriptionPromotions: SubscriptionPromotion[] = [
  {
    id: 'launch-discount',
    badge: '−15%',
    titleKey: 'subscription.launchTitle',
    descriptionKey: 'subscription.launchDescription',
    enabled: true,
    offerIds: ['ai-media'],
  },
];

function withinPromotionWindow(promotion: SubscriptionPromotion, now: Date) {
  const timestamp = now.getTime();
  const startsAt = promotion.startsAt ? Date.parse(promotion.startsAt) : Number.NEGATIVE_INFINITY;
  const endsAt = promotion.endsAt ? Date.parse(promotion.endsAt) : Number.POSITIVE_INFINITY;
  return Number.isFinite(startsAt) || startsAt === Number.NEGATIVE_INFINITY
    ? (Number.isFinite(endsAt) || endsAt === Number.POSITIVE_INFINITY) && timestamp >= startsAt && timestamp <= endsAt
    : false;
}

export function activeSubscriptionPromotion(now = new Date()) {
  return subscriptionPromotions.find(promotion => promotion.enabled && withinPromotionWindow(promotion, now)) || null;
}
