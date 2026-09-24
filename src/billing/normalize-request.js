// Keep inferred provider defaults in the stored request as well as the quote.
function normalizePricingInput(model, input = {}) {
  const result = { ...input };
  if (['wan/2-7-image', 'wan/2-7-image-pro'].includes(model?.apiModel)
    && ['num_images', 'number_of_images', 'output_count', 'image_count', 'n'].every(key => result[key] == null)) {
    result.n = result.enable_sequential === true ? 12 : 4;
  }
  return result;
}

module.exports = { normalizePricingInput };
