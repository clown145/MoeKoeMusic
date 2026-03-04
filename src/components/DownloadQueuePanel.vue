<template>
    <div v-if="totalCount > 0 || downloadQueue.isRunning" class="download-queue-wrapper" :class="{ expanded: isExpanded }">
        <button class="queue-toggle-btn" @click="togglePanel">
            <i class="fas fa-download"></i>
            <span>下载队列</span>
            <span class="queue-badge" v-if="totalCount > 0">{{ totalCount }}</span>
            <span class="queue-mini-status" v-if="downloadQueue.isRunning">
                {{ downloadQueue.downloadingCount }} 下载中
            </span>
        </button>

        <transition name="queue-panel-transition">
            <section v-if="isExpanded" class="queue-panel">
                <header class="queue-header">
                    <div class="queue-title">
                        <h4>下载任务</h4>
                        <span>
                            待下 {{ downloadQueue.pendingCount }}
                            / 下载中 {{ downloadQueue.downloadingCount }}
                            / 成功 {{ downloadQueue.successCount }}
                            / 失败 {{ downloadQueue.failedCount }}
                        </span>
                    </div>
                    <button class="queue-close-btn" @click="isExpanded = false">
                        <i class="fas fa-times"></i>
                    </button>
                </header>

                <div class="queue-progress">
                    <div class="queue-progress-bar">
                        <div class="queue-progress-fill" :style="{ width: `${progressPercent}%` }"></div>
                    </div>
                    <span>{{ progressPercent }}%</span>
                </div>

                <div class="queue-actions">
                    <button
                        class="queue-action-btn"
                        :disabled="downloadQueue.failedCount === 0"
                        @click="retryAllFailed">
                        重试失败项
                    </button>
                    <button
                        class="queue-action-btn"
                        :disabled="downloadQueue.successCount === 0"
                        @click="clearSuccess">
                        清除成功
                    </button>
                    <button
                        class="queue-action-btn"
                        :disabled="downloadQueue.failedCount === 0"
                        @click="clearFailed">
                        清除失败
                    </button>
                    <button
                        class="queue-action-btn danger"
                        :disabled="totalCount === 0"
                        @click="clearAll">
                        清空队列
                    </button>
                </div>

                <div class="queue-list">
                    <div v-if="recentTasks.length === 0" class="queue-empty">
                        暂无下载任务
                    </div>
                    <div
                        v-for="task in recentTasks"
                        :key="task.id"
                        class="queue-item"
                        :class="`status-${task.status}`">
                        <div class="queue-item-main">
                            <span class="queue-item-name" :title="taskDisplayName(task)">
                                {{ taskDisplayName(task) }}
                            </span>
                            <span class="queue-item-status">{{ statusText(task) }}</span>
                        </div>
                        <div v-if="task.status === 'failed'" class="queue-item-error" :title="task.error">
                            {{ task.error || '下载失败' }}
                        </div>
                        <div v-if="task.status === 'success' && task.downgraded" class="queue-item-tip">
                            音质降级：{{ qualityLabel(task.requestedQuality) }} -> {{ qualityLabel(task.actualQuality) }}
                        </div>
                    </div>
                </div>
            </section>
        </transition>
    </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { useDownloadQueueStore } from '@/stores/downloadQueue';

const downloadQueue = useDownloadQueueStore();
const isExpanded = ref(false);

const totalCount = computed(() => downloadQueue.tasks.length);
const recentTasks = computed(() => [...downloadQueue.tasks].slice(-80).reverse());

const progressPercent = computed(() => {
    if (totalCount.value === 0) return 0;
    const completed = downloadQueue.successCount + downloadQueue.failedCount;
    return Math.max(0, Math.min(100, Math.round((completed / totalCount.value) * 100)));
});

const QUALITY_LABEL_MAP = {
    normal: '128K',
    high: '320K',
    lossless: '无损',
    hires: 'Hi-Res',
    viper: '蝰蛇',
};

const qualityLabel = (qualityKey) => QUALITY_LABEL_MAP[qualityKey] || qualityKey || '未知';

const taskDisplayName = (task) => {
    const artist = String(task?.author || '').trim();
    const title = String(task?.name || task?.OriSongName || '').trim();
    if (artist && title) return `${artist} - ${title}`;
    return artist || title || `任务 #${task?.id || ''}`;
};

const statusText = (task) => {
    if (task.status === 'pending') return '排队中';
    if (task.status === 'downloading') {
        return task.attempts > 1 ? `下载中（第 ${task.attempts} 次）` : '下载中';
    }
    if (task.status === 'success') {
        return task.retries > 0 ? `完成（重试 ${task.retries} 次）` : '完成';
    }
    if (task.status === 'failed') {
        return `失败（重试 ${task.retries} 次）`;
    }
    return task.status || '';
};

const togglePanel = () => {
    isExpanded.value = !isExpanded.value;
};

const retryAllFailed = () => {
    const count = downloadQueue.retryFailedTasks();
    if (count > 0) {
        window.$message?.success?.(`已重新加入 ${count} 首失败歌曲`);
    }
};

const clearSuccess = () => downloadQueue.clearSuccessTasks();
const clearFailed = () => downloadQueue.clearFailedTasks();
const clearAll = () => downloadQueue.clearAllTasks();

watch(
    () => downloadQueue.tasks.length,
    (newValue, oldValue) => {
        if (newValue > oldValue) isExpanded.value = true;
    }
);

watch(
    () => downloadQueue.failedCount,
    (newValue, oldValue) => {
        if (newValue > oldValue) isExpanded.value = true;
    }
);
</script>

<style scoped>
.download-queue-wrapper {
    position: fixed;
    right: 14px;
    bottom: 124px;
    z-index: 5;
}

.queue-toggle-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    border: 1px solid var(--secondary-color);
    border-radius: 999px;
    padding: 0 12px;
    background: rgba(255, 255, 255, 0.92);
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
}

.queue-badge {
    min-width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #ff4757;
    color: #fff;
    font-size: 12px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 5px;
}

.queue-mini-status {
    color: #ff7a45;
    font-size: 12px;
}

.queue-panel {
    width: 360px;
    max-height: 58vh;
    margin-top: 10px;
    border: 1px solid var(--secondary-color);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.96);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.2);
    backdrop-filter: blur(8px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.queue-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 12px 8px;
    border-bottom: 1px solid var(--border-color, #eaeaea);
}

.queue-title h4 {
    margin: 0;
    font-size: 15px;
}

.queue-title span {
    font-size: 12px;
    color: #666;
}

.queue-close-btn {
    border: none;
    background: transparent;
    cursor: pointer;
    color: #777;
}

.queue-progress {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
}

.queue-progress-bar {
    flex: 1;
    height: 6px;
    border-radius: 999px;
    background: #ececec;
    overflow: hidden;
}

.queue-progress-fill {
    height: 100%;
    background: var(--primary-color);
}

.queue-progress span {
    font-size: 12px;
    color: #666;
    min-width: 38px;
    text-align: right;
}

.queue-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    padding: 0 12px 10px;
    border-bottom: 1px solid var(--border-color, #eaeaea);
}

.queue-action-btn {
    border: 1px solid var(--secondary-color);
    border-radius: 6px;
    background: #fff;
    height: 30px;
    font-size: 12px;
    cursor: pointer;
}

.queue-action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.queue-action-btn.danger {
    color: #d9363e;
    border-color: #f5c2c5;
}

.queue-list {
    overflow-y: auto;
    padding: 8px 10px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.queue-empty {
    color: #888;
    font-size: 13px;
    text-align: center;
    padding: 18px 0;
}

.queue-item {
    border: 1px solid var(--border-color, #eaeaea);
    border-radius: 8px;
    padding: 8px;
    background: #fff;
}

.queue-item-main {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
}

.queue-item-name {
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 13px;
}

.queue-item-status {
    font-size: 12px;
    color: #666;
    flex-shrink: 0;
}

.queue-item-error {
    margin-top: 4px;
    font-size: 12px;
    color: #cf1322;
    line-height: 1.35;
    word-break: break-word;
}

.queue-item-tip {
    margin-top: 4px;
    font-size: 12px;
    color: #ad6800;
}

.status-downloading {
    border-color: #91caff;
    background: #f0f8ff;
}

.status-success {
    border-color: #b7eb8f;
}

.status-failed {
    border-color: #ffccc7;
    background: #fff2f0;
}

.queue-panel-transition-enter-active,
.queue-panel-transition-leave-active {
    transition: all 0.16s ease;
}

.queue-panel-transition-enter-from,
.queue-panel-transition-leave-to {
    opacity: 0;
    transform: translateY(10px);
}

@media (max-width: 768px) {
    .download-queue-wrapper {
        right: 10px;
        left: 10px;
        bottom: 126px;
    }

    .queue-panel {
        width: auto;
    }
}
</style>
