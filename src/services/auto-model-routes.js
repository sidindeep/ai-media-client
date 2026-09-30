const seed = require('../../config/model-routes.json');

function modelRoutes(modelId, rows = seed.models, originModelId) {
  const direct = rows.find(row => row.id === modelId);
  const origin = originModelId || (modelId.startsWith('kie:') || modelId.startsWith('apimart:') ? modelId
    : direct?.providers.kie || (direct?.providers.apimart ? 'apimart:' + direct.providers.apimart : ''));
  const kie = origin.startsWith('kie:');
  const matches = direct ? [direct] : rows.filter(row => kie ? row.providers.kie === modelId : row.providers.apimart === modelId.slice(8));
  const providers = direct?.providers || matches[0]?.providers || (kie ? { kie: modelId } : { apimart: modelId.slice(8) });
  const order = [kie ? 'kie' : 'apimart', kie ? 'apimart' : 'kie', ...Object.keys(providers).filter(id => !['kie', 'apimart'].includes(id))];
  return order.map(providerId => {
    const ids = [...new Set(matches.map(row => row.providers[providerId]).filter(Boolean))];
    const id = providers[providerId] || ids[0] || '';
    return { providerId, modelId: id, ...(ids.length > 1 ? { modelIds: ids } : {}),
      ...(id ? {} : { unavailableReason: 'В единой таблице нет модели ' + (providerId === 'kie' ? 'Kie' : providerId === 'apimart' ? 'APIMart' : providerId) }) };
  });
}
module.exports = { modelRoutes };
