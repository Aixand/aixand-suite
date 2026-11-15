import { launchComponentWorker } from './component-launcher.mjs'
import { productUpdateAction } from './product-updates.mjs'

export function productAction(config, action, input = {}, dependencies = {}) {
  return productUpdateAction(config, action, input, { launchWorker: launchComponentWorker, ...dependencies })
}
