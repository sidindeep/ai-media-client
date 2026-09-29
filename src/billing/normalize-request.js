// Keep inferred provider defaults in the stored request as well as the quote.
function normalizePricingInput(model, input = {}) {
  const result = { ...input };
  if (['wan/2-7-image', 'wan/2-7-image-pro'].includes(model?.apiModel)
    && ['num_images', 'number_of_images', 'output_count', 'image_count', 'n'].every(key => result[key] == null)) {
    result.n = result.enable_sequential === true ? 12 : 4;
  }
  for (const field of model?.fields || []) {
    const value = field.default ?? field.schema?.default;
    if (result[field.key] == null && value !== undefined) result[field.key] = structuredClone(value);
  }
  return result;
}

module.exports = { normalizePricingInput };
