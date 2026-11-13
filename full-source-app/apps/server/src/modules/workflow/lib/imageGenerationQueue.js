/** Shared across workflow runs: two image batches / eight images per profile.
 * Reserve the entire batch atomically. Space actual submissions, not completion.
 * Provider callbacks may fire more than once during token-refresh retries.
 */
export class ImageGenerationQueue {
    constructor({ gapMs = () => 7000 + Math.floor(Math.random() * 3001), tickMs = 100 } = {}) {
        this.profiles = new Map();
        this.gapMs = gapMs;
        this.tickMs = tickMs;
    }
    run(profileId, count, isCancelled, execute, settings = null) {
        if (!profileId || !Number.isInteger(count) || count < 1 || count > 4)
            return Promise.reject(new Error('Image queue requires a profile and 1–4 images.'));
        if(settings)settings=normalizeParallel(settings);
        let state = this.profiles.get(profileId);
        if (!state) {
            state = { pending: [], batches: 0, images: 0, launching: false, nextAt: 0, pumping: false };
            this.profiles.set(profileId, state);
        }
        return new Promise((resolve, reject) => {
            state.pending.push({ count, isCancelled, execute, resolve, reject, settings: settings ?? null });
            this.pump(profileId, state);
        });
    }
    async pump(profileId, state) {
        if (state.pumping) return;
        state.pumping = true;
        try {
            while (state.pending.length || state.batches || Date.now() < state.nextAt) {
                state.pending = state.pending.filter(job => {
                    if (!job.isCancelled()) return true;
                    job.reject(new Error('Run was cancelled'));
                    return false;
                });
                const job = state.pending[0];
                const activeLimit = job?.settings
                    ? Math.min(8, job.settings.concurrency * job.settings.burst, Math.max(1, Math.floor(8 / job.count)))
                    : 2;
                if (job && !state.launching && state.batches < activeLimit && state.images + job.count <= 8 && Date.now() >= state.nextAt) {
                    state.pending.shift();
                    state.batches++;
                    state.images += job.count;
                    state.launching = job;
                    let fired = false;
                    const onSubmitFired = () => {
                        const repeated = fired;
                        const burst = job.settings?.burst || 1;
                        state.burstCount = (state.burstCount || 0) + 1;
                        const rest = job.settings ? job.settings.restSeconds * 1000 : this.gapMs();
                        const pause = state.burstCount >= burst || repeated;
                        if(pause)state.burstCount=0;
                        state.nextAt = Math.max(state.nextAt, Date.now() + (pause ? rest : 0));
                        fired = true;
                        if (state.launching === job) state.launching = false;
                    };
                    void (async () => {
                        try {
                            if (job.isCancelled()) throw new Error('Run was cancelled');
                            job.resolve(await job.execute(onSubmitFired));
                        } catch (error) {
                            job.reject(error);
                        } finally {
                            // Failed preparation must release the gate too, without a retry burst.
                            if (!fired) { onSubmitFired(); state.burstCount=0; state.nextAt=Math.max(state.nextAt,Date.now()+(job.settings?job.settings.restSeconds*1000:this.gapMs())); }
                            state.batches--;
                            state.images -= job.count;
                        }
                    })();
                }
                await new Promise(resolve => setTimeout(resolve, this.tickMs));
            }
        } finally {
            state.pumping = false;
            if (!state.pending.length && !state.batches) this.profiles.delete(profileId);
        }
    }
}

export const workflowImageQueue = new ImageGenerationQueue();

export function batchProductLanes(batch, definition) {
    const folder = definition.nodes.some(node => node.type === 'folder-input');
    const parallel = batch.parallelSettings;
    const requested = parallel
        ? Number(parallel.concurrency || 1) * Number(parallel.burst || 1)
        : batch.rowsPerProfile ?? (folder ? 2 : 1);
    const imagesPerProduct = parallel ? Number(parallel.imagesPerProduct || 1) : 1;
    const imageCapacity = Math.max(1, Math.floor(8 / imagesPerProduct));
    return Math.max(1, Math.min(singleImageWorkflow(definition) ? imageCapacity : 2, requested));
}

export function singleImageWorkflow(def) {
 const images=def.nodes.filter(n=>n.type==='generate-image');
 const count=Number(images[0]?.data?.count ?? 1);
 return images.length===1 && Number.isInteger(count) && count>=1 && count<=4 && !def.nodes.some(n=>['generate-video','upscale-image','upscale-video','character-generator'].includes(n.type));
}
export function defaultImagesPerProduct(def) {
 const image=def.nodes.find(node=>node.type==='generate-image');
 const configured=Math.max(1,Math.min(4,Number(image?.data?.count ?? 1)));
 const productFolder=def.nodes.some(node=>node.type==='folder-input'&&node.data?.groupMode==='product-images');
 return productFolder?4:configured;
}
export function normalizeParallel(value) {
 const concurrency=Number(value?.concurrency ?? 8),restSeconds=Number(value?.restSeconds ?? 10),burst=Number(value?.burst ?? 4),imagesPerProduct=Number(value?.imagesPerProduct ?? 1),storedImageModelKey=String(value?.imageModelKey || 'GEM_PIX_2'),imageModelKey=storedImageModelKey==='NARWHAL'?'BELUGA':storedImageModelKey;
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8||!Number.isFinite(restSeconds)||restSeconds<1||restSeconds>180||!Number.isInteger(burst)||burst<1||burst>4||!Number.isInteger(imagesPerProduct)||imagesPerProduct<1||imagesPerProduct>4||!['GEM_PIX_2','BELUGA','HARBOR_SEAL'].includes(imageModelKey))throw Error('Cấu hình batch: model ảnh hợp lệ, 1–8 luồng, nghỉ sau đợt 1–180 giây, 1–4 sản phẩm/đợt và 1–4 ảnh/sản phẩm.');
 return {imageModelKey,concurrency,restSeconds,burst,imagesPerProduct};
}
