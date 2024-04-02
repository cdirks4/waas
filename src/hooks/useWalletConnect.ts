import { useEffect, useState, useCallback, useMemo } from "react";
import type { Web3WalletTypes } from '@walletconnect/web3wallet'
import { getSdkError } from '@walletconnect/utils'
import { hexToUtf8 } from '@walletconnect/encoding'
import { formatJsonRpcError } from '@walletconnect/jsonrpc-utils'
import type { SessionTypes } from '@walletconnect/types'
import WalletConnectWallet from '../walletconnect/WalletConnectWallet'
import { KernelAccountClient, KernelEIP1193Provider } from "@zerodev/sdk";
import { stripEip155Prefix } from "../walletconnect/constants";
import { asError, getWrongChainError, getPeerName } from "../walletconnect/utils";

type WalletConnectHook = {
  connect: (uri: string) => void
  approve: (proposalData?: Web3WalletTypes.SessionProposal) => void
  reject: () => void
  disconnect: (session: SessionTypes.Struct) => void
  approveSessionRequest: () => void
  rejectSessionRequest: () => void
  sessionRequest: Web3WalletTypes.SessionRequest | undefined
  sessionProposal: Web3WalletTypes.SessionProposal | undefined
  isLoading: WCLoadingState | undefined
  sessions: SessionTypes.Struct[]
  error: Error | undefined
}

export enum WCLoadingState {
  APPROVE = 'Approve',
  REJECT = 'Reject',
  CONNECT = 'Connect',
  DISCONNECT = 'Disconnect',
}

type Props = {
  kernelClient: KernelAccountClient
}

export function useWalletConnect({ kernelClient }: Props): WalletConnectHook {
  const [wcWallet, setWcWallet] = useState<WalletConnectWallet>()
  const [sessionProposal, setSessionProposal] = useState<Web3WalletTypes.SessionProposal>()
  const [isLoading, setIsLoading] = useState<WCLoadingState | undefined>()
  const [error, setError] = useState<Error | undefined>()
  const [kernelProvider, setKernelProvider] = useState<KernelEIP1193Provider>()
  const [sessions, setSessions] = useState<SessionTypes.Struct[]>([])
  const [sessionRequest, setSessionRequest] = useState<Web3WalletTypes.SessionRequest>()
  const chainId = useMemo(() => kernelClient?.chain?.id, [kernelClient])
  const address = useMemo(() => kernelClient?.account?.address, [kernelClient])

  useEffect(() => {
    const getWallet = async () => {
      const wcWallet = new WalletConnectWallet()
      await wcWallet.init()
      setWcWallet(wcWallet)
    }
    getWallet()
  }, [])

  useEffect(() => {
    if (!kernelClient) return
    const provider = new KernelEIP1193Provider(kernelClient)
    setKernelProvider(provider)
  }, [kernelClient])

  const handleKernelRequest = useCallback(
    async (event: Web3WalletTypes.SessionRequest): Promise<{
      jsonrpc: string
      id: number
      result: unknown
    }> => {
      if (!kernelProvider) throw new Error('Kernel provider not initialized')

      const { params, id } = event
      const { request } = params
      if (request.method === 'personal_sign') {
        const requestParamsMessage = request.params[0]

        const message = hexToUtf8(requestParamsMessage)
        const signedMessage = await kernelProvider.request({
          ...request,
          params: [
            message,
            request.params[1]
          ]
        })

        return { id, result: signedMessage, jsonrpc: '2.0' }
      }

      if (request.method === 'eth_sign') {
        const requestParamsMessage = request.params[1]

        const message = hexToUtf8(requestParamsMessage)
        const signedMessage = await kernelProvider.request({
          ...request,
          params: [
            request.params[0],
            message,
          ]
        })

        return { id, result: signedMessage, jsonrpc: '2.0' }
      }

      const result = await kernelProvider.request(request)
      return {
        jsonrpc: '2.0',
        id: id,
        result
      }
    },
    [kernelProvider]
  )

  const approveSessionRequest = useCallback(async () => {
    const event = sessionRequest
    if (!event || !wcWallet) return

    const { topic } = event
    const session = wcWallet.getActiveSessions().find((s) => s.topic === topic)
    const requestChainId = stripEip155Prefix(event.params.chainId)

    const getResponse = () => {
      // Get error if wrong chain
      if (!session || parseInt(requestChainId) !== chainId) {
        if (session) {
          setError(getWrongChainError(getPeerName(session.peer)))
        }

        const error = getSdkError('UNSUPPORTED_CHAINS')
        return formatJsonRpcError(event.id, error)
      }
      setSessionRequest(undefined)
      return handleKernelRequest(event)
    }

    try {
      const response = await getResponse()

      // Send response to WalletConnect
      await wcWallet.sendSessionResponse(topic, response)
    } catch (e) {
      setError(asError(e))
      const errorResponse = formatJsonRpcError(event.id, {
        code: 5000,
        message: (e as Error)?.message,
      })
      await wcWallet.sendSessionResponse(topic, errorResponse)
    } finally {
      setSessionRequest(undefined)
    }
  }, [sessionRequest, handleKernelRequest, wcWallet, chainId])

  const rejectSessionRequest = useCallback(async () => {
    if (!wcWallet || !sessionRequest) return

    const { topic } = sessionRequest
    const errorResponse = formatJsonRpcError(sessionRequest.id, {
      code: 5000,
      message: 'User Rejected',
    })
    await wcWallet.sendSessionResponse(topic, errorResponse)
    setSessionRequest(undefined)
  }, [wcWallet, sessionRequest])

  // Subscribe to requests
  useEffect(() => {
    if (!wcWallet || !kernelProvider || !chainId) return

    return wcWallet.onRequest(async (event) => {
      setSessionRequest(event);
    })
  }, [wcWallet, chainId, kernelProvider, handleKernelRequest])

  // Update chainId/address
  useEffect(() => {
    if (!wcWallet || !chainId || !address) return

    wcWallet.updateSessions(chainId.toString(), address).catch((e: Error) => {
      setError(asError(e))
    })
  }, [wcWallet, chainId, address])

  const connect = useCallback(
    async (uri: string) => {
      if (!wcWallet) return

      if (uri && !uri.startsWith('wc:')) {
        setError(new Error('Invalid pairing code'))
        return
      }

      setError(undefined)

      setIsLoading(WCLoadingState.CONNECT)
      try {
        await wcWallet.connect(uri)
      } catch (e) {
        setError(asError(e))
      }
      setIsLoading(undefined)
    }, [wcWallet, setIsLoading])

  const approve = useCallback(
    async (proposalData?: Web3WalletTypes.SessionProposal) => {
      const proposal = proposalData || sessionProposal

      if (!wcWallet || !chainId || !address || !proposal) return

      setIsLoading(WCLoadingState.APPROVE)

      try {
        await wcWallet.approveSession(proposal, chainId.toString(), address)
      } catch (e) {
        setError(asError(e))
      }

      setIsLoading(undefined)
      setSessionProposal(undefined)
    },
    [sessionProposal, wcWallet, chainId, address, setIsLoading],
  )

  // Subscribe to session proposals
  useEffect(() => {
    if (!wcWallet) return
    return wcWallet.onSessionPropose((proposalData) => {
      // setError(null)

      setSessionProposal(proposalData)
    })
  }, [wcWallet, approve, chainId])

  // On session reject
  const reject = useCallback(async () => {
    if (!wcWallet || !sessionProposal) return

    setIsLoading(WCLoadingState.REJECT)

    try {
      await wcWallet.rejectSession(sessionProposal)
    } catch (e) {
      setError(asError(e))
    }

    setIsLoading(undefined)
    setSessionProposal(undefined)
  }, [wcWallet, sessionProposal, setIsLoading, setSessionProposal])

  const disconnect = async (session: SessionTypes.Struct) => {
    if (!wcWallet) return

    setIsLoading(WCLoadingState.DISCONNECT)

    try {
      await wcWallet.disconnectSession(session)
    } catch (e) {
      setError(asError(e))
    }

    setIsLoading(undefined)
  }

  const updateSessions = useCallback(() => {
    if (!wcWallet) return
    setSessions(wcWallet.getActiveSessions())
  }, [wcWallet])

  // Initial sessions
  useEffect(updateSessions, [updateSessions])

  // On session add
  useEffect(() => {
    if (!wcWallet) return
    return wcWallet.onSessionAdd(updateSessions)
  }, [wcWallet, updateSessions])

  // On session delete
  useEffect(() => {
    if (!wcWallet) return
    return wcWallet.onSessionDelete(updateSessions)
  }, [wcWallet, updateSessions])

  return {
    connect,
    approve,
    reject,
    disconnect,
    approveSessionRequest,
    rejectSessionRequest,
    sessionProposal,
    sessionRequest,
    isLoading,
    sessions,
    error,
  }
}

