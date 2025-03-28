import express from 'express'
import cors from 'cors'
import path from 'path'
import dotenv from 'dotenv'

import { RateLimiter, VerifyCaptcha, parseBody, parseURI } from './middlewares'
import EVM from './vms/evm'

import {
    SendTokenResponse,
    ChainType,
    EVMInstanceAndConfig,
} from './types'

import {
    evmchains,
    erc20tokens,
    couponConfig,
    GLOBAL_RL,
    NATIVE_CLIENT,
    DEBUG,
    MAINNET_BALANCE_CHECK_RPC,
    MAINNET_BALANCE_CHECK_CHAIN_ID,
} from './config.json'
import { CouponService } from './CouponService/couponService'
import {
    PIPELINE_CHECKS,
    PipelineCheckValidity,
    checkCouponPipeline,
    checkMainnetBalancePipeline,
    pipelineFailureMessage
} from './utils/pipelineChecks'
import { MainnetCheckService } from './mainnetCheckService'

dotenv.config()

const app: any = express()
const router: any = express.Router()

app.use(cors())
app.use(parseURI)
app.use(parseBody)

if (NATIVE_CLIENT) {
    app.use(express.static(path.join(__dirname, "client")))
}

new RateLimiter(app, [GLOBAL_RL])

new RateLimiter(app, [
    ...evmchains,
    ...erc20tokens
])

// address rate limiter
new RateLimiter(app, [
    ...evmchains,
    ...erc20tokens
], (req: any, res: any) => {
    const addr = req.body?.address

    if(typeof addr == "string" && addr) {
        return addr.toUpperCase()
    }
})

const couponService = new CouponService(couponConfig)
const mainnetCheckService = new MainnetCheckService(MAINNET_BALANCE_CHECK_RPC)

const captcha: VerifyCaptcha = new VerifyCaptcha(app, process.env.CAPTCHA_SECRET!, process.env.V2_CAPTCHA_SECRET!)

let evms = new Map<string, EVMInstanceAndConfig>()

// Get the complete config object from the array of config objects (chains) with ID as id
const getChainByID = (chains: ChainType[], id: string): ChainType | undefined => {
    let reply: ChainType | undefined
    chains.forEach((chain: ChainType): void => {
        if(chain.ID == id) {
            reply = chain
        }
    })
    return reply
}

const separateConfigFields = ['COUPON_REQUIRED', 'MAINNET_BALANCE_CHECK_ENABLED']

// Populates the missing config keys of the child using the parent's config
const populateConfig = (child: any, parent: any): any => {
    Object.keys(parent || {}).forEach((key) => {
        // Do not copy configs of separateConfigFields (in ERC20 tokens) from host chain
        if(!separateConfigFields.includes(key) && !child[key]) {
            child[key] = parent[key]
        }
    })
    return child
}

// Setting up instance for EVM chains
evmchains.forEach((chain: ChainType): void => {
    const chainInstance: EVM = new EVM(chain, (process.env[chain.ID] || process.env.PK)!)
    
    evms.set(chain.ID, {
        config: chain,
        instance: chainInstance
    })
})

// Adding ERC20 token contracts to their HOST evm instances
erc20tokens.forEach((token: any, i: number): void => {
    if(token.HOSTID) {
        token = populateConfig(token, getChainByID(evmchains, token.HOSTID))
    }

    erc20tokens[i] = token
    const evm: EVMInstanceAndConfig = evms.get(getChainByID(evmchains, token.HOSTID)?.ID!)!

    evm?.instance.addERC20Contract(token)
})

// POST request for sending tokens or coins
router.post('/sendToken', captcha.middleware, async (req: any, res: any) => {
    const address: string = req.body?.address
    const chain: string = req.body?.chain
    const erc20: string | undefined = req.body?.erc20
    const coupon: string | undefined = req.body?.couponId

    // initialize instances
    const evm = evms.get(chain)
    const erc20Instance = evm?.instance?.contracts?.get(erc20 ?? "")

    // validate parameters
    if (evm === undefined || (erc20 && erc20Instance === undefined)) {
        res.status(400).send({ message: 'Invalid parameters passed!' })
        return
    }

    // unique id for each token
    const faucetConfigId = erc20Instance?.config.ID ?? evm?.config.ID

    // drip amount (native or erc20 token) for this request as per config
    const dripAmount = erc20Instance?.config.DRIP_AMOUNT ?? evm.config.DRIP_AMOUNT

    /**
     * Pipeline Checks
     * 1. Pipelines are checks or rules that a request goes through before being processed
     * 2. The request should pass at least one pipeline check
     * 3. If no pipeline check is required for a token, then directly process the request
     * 4. Currently, we have 2 pipeline checks: Coupon Check & Mainnet Balance Check
     */
    const mainnetCheckEnabled = (erc20Instance ? erc20Instance.config.MAINNET_BALANCE_CHECK_ENABLED : evm.config.MAINNET_BALANCE_CHECK_ENABLED) ?? false
    const couponCheckEnabled = couponConfig.IS_ENABLED && ((erc20Instance ? erc20Instance.config.COUPON_REQUIRED : evm.config.COUPON_REQUIRED) ?? false)

    let pipelineValidity: PipelineCheckValidity = {isValid: false, dripAmount}
    !pipelineValidity.isValid && couponCheckEnabled && await checkCouponPipeline(couponService, pipelineValidity, faucetConfigId, coupon)
    
    // don't check mainnet balance, if coupon is provided
    !pipelineValidity.isValid && !coupon && mainnetCheckEnabled && await checkMainnetBalancePipeline(mainnetCheckService, pipelineValidity, MAINNET_BALANCE_CHECK_RPC, address)

    if (
        (mainnetCheckEnabled || couponCheckEnabled) &&
        !pipelineValidity.isValid
    ) {
        // failed
        res.status(400).send({message: pipelineValidity.errorMessage + pipelineFailureMessage(MAINNET_BALANCE_CHECK_RPC, couponCheckEnabled)})
        return
    }

    // logging requests (if enabled)
    DEBUG && console.log(JSON.stringify({
        date: new Date(),
        type: "NewFaucetRequest",
        faucetConfigId,
        address,
        chain,
        erc20,
        checkPassedType: pipelineValidity.checkPassedType,
        dripAmount: pipelineValidity.dripAmount,
        mainnetBalance: pipelineValidity.mainnetBalance,
        ip: req.headers["cf-connecting-ip"] || req.ip
    }))

    // send request
    evm.instance.sendToken(address, erc20, pipelineValidity.dripAmount, async (data: SendTokenResponse) => {
        const { status, message, txHash } = data

        // reclaim coupon if transaction is failed
        if (pipelineValidity.checkPassedType === PIPELINE_CHECKS.COUPON && coupon && txHash === undefined) {
            await couponService.reclaimCouponAmount(coupon, pipelineValidity.dripAmount)
        }
        res.status(status).send({message, txHash})
    })
})

// POST request for sending tokens or coins
router.post('/claimToken', async (req: any, res: any) => {
    const address: string = req.body?.address
    const chain: string = req.body?.chain
    const dripAmount: number = req.body?.amount
    const erc20: string | undefined = req.body?.erc20
    const coupon: string | undefined = req.body?.coupon

    if (!dripAmount || dripAmount <= 0) {
        res.status(400).send({ message: 'Invalid amount passed!' })
        return
    }

    if (coupon !== process.env.NEO_COUPON_ID) {
        res.status(400).send({ message: 'Invalid coupon passed!' })
        return
    }

    // initialize instances
    const evm = evms.get(chain)
    const erc20Instance = evm?.instance?.contracts?.get(erc20 ?? "")

    // validate parameters
    if (evm === undefined || (erc20 && erc20Instance === undefined)) {
        res.status(400).send({ message: 'Invalid parameters passed!' })
        return
    }

    evm.instance.sendToken(address, erc20, dripAmount, async (data: SendTokenResponse) => {
        const { status, message, txHash } = data
        res.status(status).send({message, txHash})
    })
})

// POST request for batch sending native token and ERC20 tokens
router.post('/batchClaimToken', async (req: any, res: any) => {
    const address: string = req.body?.address
    const chain: string = req.body?.chain ?? "KITE"
    const kiteAmount: number = req.body?.kiteAmount
    const erc20: string | undefined = req.body?.erc20 ?? "USDT"
    const erc20Amount: number = req.body?.erc20Amount
    const coupon: string | undefined = req.body?.coupon

    if (!kiteAmount || kiteAmount <= 0) {
        res.status(400).send({ message: 'Invalid amount passed!' })
        return
    }

    if (coupon !== process.env.NEO_COUPON_ID) {
        res.status(400).send({ message: 'Invalid coupon passed!' })
        return
    }

    // initialize instances
    const evm = evms.get(chain)
    const erc20Instance = evm?.instance?.contracts?.get(erc20 ?? "")

    // validate parameters
    if (evm === undefined || (erc20 && erc20Instance === undefined)) {
        res.status(400).send({ message: 'Invalid parameters passed!' })
        return
    }

    const nativeTransferPromise = new Promise<SendTokenResponse>((resolve, reject) => {
        try {
            evm.instance.sendToken(address, undefined, kiteAmount, async (data: SendTokenResponse) => {
                const { status, message, txHash } = data
                resolve({ status, message, txHash })
            })
        } catch (err: any) {
            reject(err)
        }
    })

    const erc20TransferPromise = new Promise<SendTokenResponse>((resolve, reject) => {
        try {
            evm.instance.sendToken(address, erc20, erc20Amount, async (data: SendTokenResponse) => {
                const { status, message, txHash } = data
                resolve({ status, message, txHash })
            })
        } catch (err: any) {
            reject(err)
        }
    })

    Promise.all([nativeTransferPromise, erc20TransferPromise]).then(([nativeTransfer, erc20Transfer]) => {
        if (nativeTransfer.status === 200 && erc20Transfer.status === 200) {
            res.status(200).send({ message: 'Tokens sent successfully', data: { nativeTxHash: nativeTransfer.txHash, erc20TxHash: erc20Transfer.txHash } })
        } else if (nativeTransfer.status === 200) {
            res.status(400).send({ message: 'Native token sent successfully', data: { nativeTxHash: nativeTransfer.txHash, erc20TxHash: null } })
        } else if (erc20Transfer.status === 200) {
            res.status(400).send({ message: 'ERC20 token sent successfully', data: { nativeTxHash: null, erc20TxHash: erc20Transfer.txHash } })
        } else {
            res.status(400).send({ message: 'Failed to send tokens' })
        }
    }).catch((err: any) => {
        res.status(400).send({ message: err.message })
    })
});

// GET request for fetching all the chain and token configurations
router.get('/getChainConfigs', (req: any, res: any) => {
    const configs: any = [...evmchains, ...erc20tokens]
    res.send({ configs, MAINNET_BALANCE_CHECK_RPC, MAINNET_BALANCE_CHECK_CHAIN_ID })
})

// GET request for fetching faucet address for the specified chain
router.get('/faucetAddress', (req: any, res: any) => {
    const chain: string = req.query?.chain
    const evm: EVMInstanceAndConfig = evms.get(chain)!

    res.send({
        address: evm?.instance.account.address
    })
})

// GET request for fetching faucet balance for the specified chain or token
router.get('/getBalance', (req: any, res: any) => {
    const chain: string = req.query?.chain
    const erc20: string | undefined = req.query?.erc20

    const evm: EVMInstanceAndConfig = evms.get(chain)!

    let balance: bigint = evm?.instance.getBalance(erc20)

    if(balance) {
        balance = balance
    } else {
        balance = BigInt(0)
    }

    res.status(200).send({
        balance: balance?.toString()
    })
})

router.get('/faucetUsage', (req: any, res: any) => {
    const chain: string = req.query?.chain

    const evm: EVMInstanceAndConfig = evms.get(chain)!

    const usage: number = evm?.instance?.getFaucetUsage()

    res.status(200).send({
        usage
    })
})

app.use('/api', router)

app.get('/health', (req: any, res: any) => {
    res.status(200).send('Server healthy')
})

app.get('/ip', (req: any, res: any) => {
    res.status(200).send({
        ip: req.headers["cf-connecting-ip"] || req.ip
    })
})

app.get('*', async (req: any, res: any) => {
    const chain = req.query.subnet;
    const erc20 = req.query.erc20;
    if (NATIVE_CLIENT) {
        res.sendFile(path.join(__dirname, "client", "index.html"))
    } else {
        res.redirect(`https://core.app/tools/testnet-faucet${chain ? "?subnet=" + chain + (erc20 ? "&token=" + erc20 : "") : ""}`);
    }
})

app.listen(process.env.PORT || 8000, () => {
    console.log(`Server started at port ${process.env.PORT || 8000}`)
})
