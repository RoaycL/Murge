import brandSource from '../../brand.config.json'

export interface BrandConfig {
  productName: string
  shortName: string
  description: string
  appId: string
  executableName: string
  protocolScheme: string
  defaultProfileName: string
  companyName: string
  repositoryUrl: string
  supportUrl: string
  copyright: string
  /**
   * Explicit, owner-curated catalog of product names a released build has used
   * as its default application-data folder. Never derived from the current
   * `productName` so a rename cannot orphan historical data.
   */
  legacyProductNames: string[]
  /**
   * Explicit, owner-curated catalog of app-data namespaces (folder names) a
   * released build may have written under before the `appId` namespace was
   * adopted. Keyed to {@link APP_DATA_NAMESPACE} during migration.
   */
  legacyAppDataNamespaces: string[]
}

export const brand = Object.freeze(brandSource satisfies BrandConfig)
