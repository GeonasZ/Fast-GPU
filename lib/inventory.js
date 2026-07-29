function isStaleInventoryError(error) {
  const message = String(error?.message || '');
  const supplierCode = String(error?.details?.code || error?.details?.errorCode || error?.details?.error_code || '');
  const supplierMessage = String(error?.details?.message || error?.details?.msg || '');
  const text = `${supplierCode} ${message} ${supplierMessage}`;
  return /(?:insufficient|no|not\s+enough|out.?of|sold.?out)\s*(?:gpu\s*)?(?:capacity|stock)|(?:capacity|stock)\s*(?:unavailable|exhausted|shortage)|resource\s*(?:exhausted|shortage)|flavor\s+.+\s+does\s+not\s+exist|容量不足|库存不足|无库存|资源不足|资源已售罄/i.test(text);
}

module.exports={isStaleInventoryError};
