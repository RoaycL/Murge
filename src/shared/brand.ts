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
}

export const brand = Object.freeze(brandSource satisfies BrandConfig)
