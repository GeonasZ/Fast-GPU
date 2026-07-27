go(restoreUiState());
Promise.allSettled([loadProviderConfig(), loadOffers(), pollInstances()]);
