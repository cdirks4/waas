import { EIP155  } from './constants'

export const stripEip155Prefix = (eip155Address: string): string => {
  return eip155Address.split(':').pop() ?? ''
}

export const getEip155ChainId = (chainId: string): string => {
  return `${EIP155}:${chainId}`
}
