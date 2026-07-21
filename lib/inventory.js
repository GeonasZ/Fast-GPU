function isStaleInventoryError(error) {
  const message = String(error?.message || '');
  const supplierCode = String(error?.details?.code || error?.details?.errorCode || error?.details?.error_code || '');
  const text = `${supplierCode} ${message}`;
  return /(?:insufficient|no|out.?of|sold.?out)\s*(?:gpu\s*)?(?:capacity|stock)|(?:capacity|stock)\s*(?:unavailable|exhausted|shortage)|resource\s*(?:exhausted|shortage)|容量不足|库存不足|无库存|资源不足|资源已售罄/i.test(text);
}

module.exports={isStaleInventoryError};
