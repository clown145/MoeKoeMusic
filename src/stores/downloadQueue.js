import { defineStore } from 'pinia';
import { get } from '../utils/request';
import { MoeAuthStore } from './store';

const QUALITY_MAP = {
    normal: '128',
    high: '320',
    lossless: 'flac',
    hires: 'high',
    viper: 'viper_clear',
};

const QUALITY_FALLBACK_CHAIN = {
    viper: ['viper', 'hires', 'lossless', 'high', 'normal'],
    hires: ['hires', 'lossless', 'high', 'normal'],
    lossless: ['lossless', 'high', 'normal'],
    high: ['high', 'normal'],
    normal: ['normal'],
};

const QUALITY_LABEL_MAP = {
    normal: '128K',
    high: '320K',
    lossless: '无损',
    hires: 'Hi-Res',
    viper: '蝰蛇',
};

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_BASE_MS = 800;
const SCHEDULER_TICK_MS = 120;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sanitizeFileName = (name, fallback = 'unknown') => {
    const safeName = String(name || '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim();
    return safeName || fallback;
};

const getDownloadExt = (extName, url) => {
    const normalizedExt = String(extName || '').replace(/^\./, '').toLowerCase();
    if (normalizedExt && /^[a-z0-9]{1,5}$/.test(normalizedExt)) {
        return normalizedExt;
    }
    try {
        const pathname = new URL(url).pathname || '';
        const match = pathname.match(/\.([a-z0-9]{1,5})$/i);
        if (match && match[1]) return match[1].toLowerCase();
    } catch {}
    return 'mp3';
};

const normalizeQualityKey = (qualityKey) => QUALITY_MAP[qualityKey] ? qualityKey : 'normal';

const compactErrorMessage = (value, fallback = '下载失败') => {
    const text = String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) return fallback;
    return text.length > 180 ? `${text.slice(0, 180)}...` : text;
};

const getSettings = () => {
    try {
        return JSON.parse(localStorage.getItem('settings') || '{}');
    } catch {
        return {};
    }
};

const getDownloadConcurrency = () => {
    const raw = Number(getSettings()?.downloadConcurrency);
    if (!Number.isFinite(raw)) return 2;
    return Math.min(8, Math.max(1, Math.round(raw)));
};

const getPreferredDownloadQuality = () => {
    const settings = getSettings();
    return normalizeQualityKey(settings?.downloadQuality || settings?.playbackQuality || settings?.quality || 'normal');
};

const getQualityLabel = (qualityKey) => QUALITY_LABEL_MAP[qualityKey] || qualityKey || '未知';

const isElectronSaveAvailable = () => {
    return typeof window !== 'undefined' &&
        !!window.electronAPI &&
        typeof window.electronAPI.downloadFileToDirectory === 'function';
};

const triggerBlobDownload = (blob, fileName) => {
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = fileName;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 3000);
};

const resolveDownloadInfo = async (hash, isAuthenticated) => {
    const params = { hash };
    const buildResult = (response, requestedQuality, actualQuality) => {
        const downloadUrl = response.url[0];
        return {
            url: downloadUrl,
            ext: getDownloadExt(response.extName, downloadUrl),
            requestedQuality,
            actualQuality,
            downgraded: requestedQuality !== actualQuality,
        };
    };

    if (!isAuthenticated) {
        params.free_part = 1;
        const response = await get('/song/url', params);
        if (response.status !== 1 || !response.url?.[0]) {
            throw new Error('获取歌曲下载链接失败');
        }
        return buildResult(response, 'normal', 'normal');
    }

    const requestedQuality = getPreferredDownloadQuality();
    const fallbackQualities = QUALITY_FALLBACK_CHAIN[requestedQuality] || ['normal'];
    let lastResponse = null;

    for (const qualityKey of fallbackQualities) {
        const response = await get('/song/url', {
            ...params,
            quality: QUALITY_MAP[qualityKey],
        });
        lastResponse = response;

        if (response.status === 1 && response.url?.[0]) {
            return buildResult(response, requestedQuality, qualityKey);
        }
        if (response.status === 2) throw new Error('登录状态失效，请重新登录');
        if (response.status === 3) throw new Error('该歌曲暂无版权');
    }

    const triedQualitiesText = fallbackQualities.map(getQualityLabel).join(' -> ');
    const reason = compactErrorMessage(lastResponse?.error || lastResponse?.msg || lastResponse?.message, '获取歌曲下载链接失败');
    throw new Error(`所选音质不可用（已尝试：${triedQualitiesText}），${reason}`);
};

const buildDownloadFileName = (task, ext) => {
    const artist = sanitizeFileName(task.author, 'Unknown Artist');
    const title = sanitizeFileName(task.name || task.OriSongName, `Track_${task.id}`);
    return `${artist} - ${title}.${ext}`;
};

const saveByElectron = async ({ url, directory, fileName }) => {
    const result = await window.electronAPI.downloadFileToDirectory({
        url,
        directory,
        fileName,
    });
    if (!result?.success) throw new Error(result?.message || '保存文件失败');
};

const saveByBrowser = async ({ url, fileName }) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    triggerBlobDownload(blob, fileName);
};

export const useDownloadQueueStore = defineStore('DownloadQueue', {
    state: () => ({
        tasks: [],
        nextId: 1,
        schedulerRunning: false,
    }),
    getters: {
        pendingTasks: (state) => state.tasks.filter((task) => task.status === 'pending'),
        downloadingTasks: (state) => state.tasks.filter((task) => task.status === 'downloading'),
        failedTasks: (state) => state.tasks.filter((task) => task.status === 'failed'),
        successTasks: (state) => state.tasks.filter((task) => task.status === 'success'),
        pendingCount() { return this.pendingTasks.length; },
        downloadingCount() { return this.downloadingTasks.length; },
        failedCount() { return this.failedTasks.length; },
        successCount() { return this.successTasks.length; },
        downgradedCount: (state) => state.tasks.filter((task) => task.status === 'success' && task.downgraded).length,
        isRunning() {
            return this.schedulerRunning || this.pendingCount > 0 || this.downloadingCount > 0;
        },
    },
    actions: {
        enqueueTracks(tracks, options = {}) {
            if (!Array.isArray(tracks) || tracks.length === 0) return 0;

            const directory = String(options.directory || '').trim();
            const now = Date.now();
            let addedCount = 0;

            for (const track of tracks) {
                if (!track?.hash) continue;
                this.tasks.push({
                    id: this.nextId++,
                    hash: track.hash,
                    name: track.name || '',
                    author: track.author || '',
                    OriSongName: track.OriSongName || '',
                    directory,
                    status: 'pending',
                    attempts: 0,
                    retries: 0,
                    error: '',
                    requestedQuality: '',
                    actualQuality: '',
                    downgraded: false,
                    createdAt: now,
                    updatedAt: now,
                });
                addedCount++;
            }

            if (addedCount > 0) {
                this.startScheduler();
            }

            return addedCount;
        },

        async startScheduler() {
            if (this.schedulerRunning) return;
            this.schedulerRunning = true;
            try {
                while (true) {
                    const concurrency = getDownloadConcurrency();
                    const activeCount = this.downloadingCount;
                    const availableSlots = Math.max(0, concurrency - activeCount);

                    if (availableSlots > 0) {
                        const waitingTasks = this.pendingTasks.slice(0, availableSlots);
                        waitingTasks.forEach((task) => {
                            void this.runTask(task.id);
                        });
                    }

                    if (this.pendingCount === 0 && this.downloadingCount === 0) {
                        break;
                    }

                    await sleep(SCHEDULER_TICK_MS);
                }
            } finally {
                this.schedulerRunning = false;
            }
        },

        async runTask(taskId) {
            const index = this.tasks.findIndex((task) => task.id === taskId);
            if (index === -1) return;

            const task = this.tasks[index];
            if (task.status !== 'pending') return;

            task.status = 'downloading';
            task.updatedAt = Date.now();
            task.error = '';

            const result = await this.downloadTaskWithRetry(task);

            const latestIndex = this.tasks.findIndex((item) => item.id === taskId);
            if (latestIndex === -1) return;
            const latestTask = this.tasks[latestIndex];

            latestTask.attempts = result.attempts;
            latestTask.retries = Math.max(result.attempts - 1, 0);
            latestTask.updatedAt = Date.now();

            if (result.success) {
                latestTask.status = 'success';
                latestTask.error = '';
                latestTask.requestedQuality = result.meta?.requestedQuality || '';
                latestTask.actualQuality = result.meta?.actualQuality || '';
                latestTask.downgraded = !!result.meta?.downgraded;
            } else {
                latestTask.status = 'failed';
                latestTask.error = result.reason || '下载失败';
            }
        },

        async downloadTaskWithRetry(task) {
            let attempt = 1;
            let lastError = null;

            while (attempt <= MAX_ATTEMPTS) {
                try {
                    const meta = await this.downloadTaskOnce(task);
                    return { success: true, attempts: attempt, meta };
                } catch (error) {
                    lastError = error;
                    if (attempt >= MAX_ATTEMPTS) break;
                    await sleep(RETRY_DELAY_BASE_MS * attempt);
                    attempt++;
                }
            }

            return {
                success: false,
                attempts: MAX_ATTEMPTS,
                reason: compactErrorMessage(lastError?.message || lastError),
            };
        },

        async downloadTaskOnce(task) {
            const MoeAuth = MoeAuthStore();
            const info = await resolveDownloadInfo(task.hash, !!MoeAuth.isAuthenticated);
            const fileName = buildDownloadFileName(task, info.ext);

            if (isElectronSaveAvailable()) {
                if (!task.directory) {
                    throw new Error('未选择下载目录');
                }
                await saveByElectron({
                    url: info.url,
                    directory: task.directory,
                    fileName,
                });
            } else {
                await saveByBrowser({
                    url: info.url,
                    fileName,
                });
            }

            return {
                requestedQuality: info.requestedQuality,
                actualQuality: info.actualQuality,
                downgraded: info.downgraded,
            };
        },

        retryFailedTasks() {
            let changed = 0;
            this.tasks.forEach((task) => {
                if (task.status !== 'failed') return;
                task.status = 'pending';
                task.error = '';
                task.attempts = 0;
                task.retries = 0;
                task.updatedAt = Date.now();
                changed++;
            });
            if (changed > 0) this.startScheduler();
            return changed;
        },

        clearSuccessTasks() {
            this.tasks = this.tasks.filter((task) => task.status !== 'success');
        },

        clearFailedTasks() {
            this.tasks = this.tasks.filter((task) => task.status !== 'failed');
        },

        clearAllTasks() {
            this.tasks = [];
        },
    },
});
