export type VoyagerQueryIds = {
  profileUpdates: string;
  messengerConversations: string;
  messengerMessages: string;
};

const DEFAULT_QUERY_IDS: VoyagerQueryIds = Object.freeze({
  profileUpdates: 'voyagerFeedDashProfileUpdates.20c70fe0314184158516a7ec004c0408',
  messengerConversations: 'messengerConversations.9501074288a12f3ae9e3c7ea243bccbf',
  messengerMessages: 'messengerMessages.5846eeb71c981f11e0134cb6626cc314',
});

let activeQueryIds: VoyagerQueryIds = { ...DEFAULT_QUERY_IDS };

export function getQueryIds(): Readonly<VoyagerQueryIds> {
  return activeQueryIds;
}

export function setQueryIds(partial: Partial<VoyagerQueryIds>): VoyagerQueryIds {
  activeQueryIds = { ...activeQueryIds, ...partial };
  return activeQueryIds;
}

export function resetQueryIds(): void {
  activeQueryIds = { ...DEFAULT_QUERY_IDS };
}

export { DEFAULT_QUERY_IDS };