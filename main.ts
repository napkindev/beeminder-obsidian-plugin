import { Plugin, PluginSettingTab, Setting, App, TFile, WorkspaceLeaf, Modal } from "obsidian";

// 1. Extend the Settings Interface
interface BeeminderSettings {
    apiKey: string;
    username: string;
    goals: Array<{
        slug: string;
        filePath: string;
        isAutoSubmit: boolean;
        metricType: 'wordCount' | 'completedTasks' | 'uncompletedTasks';
        pollingFrequency: {
            hours: number;
            minutes: number;
            seconds: number;
        };
    }>;
}

const DEFAULT_SETTINGS: BeeminderSettings = {
    apiKey: '',
    username: '',
    goals: [],
};

export default class ExamplePlugin extends Plugin {
    statusBarTextElement: HTMLSpanElement;
    settings: BeeminderSettings;
    private intervalId: number | null = null;

    async onload() {
        console.log("Hello world");
        this.statusBarTextElement = this.addStatusBarItem().createEl('span');
        this.statusBarTextElement.textContent = "beeminder";

        // Load settings
        await this.loadSettings();

        // Add settings tab
        this.addSettingTab(new BeeminderSettingTab(this.app, this));

        // Event listeners
        this.app.workspace.on('active-leaf-change', async () => {
            const file = this.app.workspace.getActiveFile();
            if (file && this.settings.goals.some(goal => goal.filePath === file.path)) {
                const content = await this.app.vault.read(file);
                console.log(content);
                this.updateCompletedTaskCount(content);
                await this.checkAndUpdateBeeminder(content, file.path);
            }
        });

        this.app.workspace.on('editor-change', async editor => {
            const file = this.app.workspace.getActiveFile();
            if (file && this.settings.goals.some(goal => goal.filePath === file.path)) {
                const content = editor.getDoc().getValue();
                this.updateCompletedTaskCount(content);
                await this.checkAndUpdateBeeminder(content, file.path);
            }
        });

        // Add hotkeys for up to 10 goals
        for (let i = 1; i <= 10; i++) {
            this.addCommand({
                id: `submit-beeminder-datapoint-goal-${i}`,
                name: `Submit Beeminder Datapoint for Goal ${i}`,
                callback: () => this.manualSubmitDatapoint(i - 1),
            });
        }

        // Set up interval for automatic submissions if enabled
        this.setupAutoSubmit();
    }

    onunload() {
        console.log("Goodbye world");
        if (this.intervalId) {
            window.clearInterval(this.intervalId);
        }
    }

    private async manualSubmitDatapoint(goalIndex?: number) {
        const file = this.app.workspace.getActiveFile();
        if (file) {
            const content = await this.app.vault.read(file);
            if (goalIndex !== undefined && goalIndex < this.settings.goals.length) {
                const goal = this.settings.goals[goalIndex];
                await this.checkAndUpdateBeeminder(content, goal.filePath);
            } else {
                // If no specific goal is specified, check all goals
                await this.checkAndUpdateBeeminder(content, file.path);
            }
        }
    }

    public setupAutoSubmit() {
        // Clear all existing intervals
        if (this.intervalId) {
            window.clearInterval(this.intervalId);
            this.intervalId = null;
        }

        // Set up new intervals for each auto-submit goal
        this.settings.goals.forEach((goal, index) => {
            if (goal.isAutoSubmit) {
                const totalMilliseconds = 
                    (goal.pollingFrequency.hours * 3600 +
                     goal.pollingFrequency.minutes * 60 +
                     goal.pollingFrequency.seconds) * 1000;
                
                window.setInterval(() => {
                    this.autoSubmitDatapoint(index);
                }, totalMilliseconds);
            }
        });
    }

    private async autoSubmitDatapoint(goalIndex: number) {
        const goal = this.settings.goals[goalIndex];
        const file = this.app.vault.getAbstractFileByPath(goal.filePath);
        if (file instanceof TFile) {
            const content = await this.app.vault.read(file);
            await this.checkAndUpdateBeeminder(content, goal.filePath);
        }
    }

    private updateCompletedTaskCount(fileContent?: string) {
        const count = fileContent ? fileContent.split(/\r?\n/).filter(line => line.trim().startsWith("- [x]")).length : 0;
        const tasksWord = count === 1 ? "completed task" : "completed tasks";
        this.statusBarTextElement.textContent = `${count} ${tasksWord}`;
    }

    private async checkAndUpdateBeeminder(fileContent: string, filePath: string) {
        const completedTasksCount = fileContent.split(/\r?\n/).filter(line => line.trim().startsWith("- [x]")).length;
        const goal = this.settings.goals.find(g => g.filePath === filePath);
        if (goal) {
            const currentBeeminderValue = await this.getBeeminderCurrentValue(goal.slug);
            if (completedTasksCount !== currentBeeminderValue) {
                await this.pushBeeminderDataPoint(completedTasksCount, goal.slug);
            }
        }
    }

    private async getBeeminderCurrentValue(goalSlug: string): Promise<number> {
        const response = await fetch(`https://www.beeminder.com/api/v1/users/${this.settings.username}/goals/${goalSlug}.json?auth_token=${this.settings.apiKey}`);
        const data = await response.json();
        return data.curval;
    }

    private async pushBeeminderDataPoint(value: number, goalSlug: string) {
        const response = await fetch(`https://www.beeminder.com/api/v1/users/${this.settings.username}/goals/${goalSlug}/datapoints.json?auth_token=${this.settings.apiKey}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                value: value,
                comment: "Updated from Obsidian Plugin"
            })
        });
        const data = await response.json();
        console.log("Data pushed to Beeminder:", data);
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.setupAutoSubmit(); // Reconfigure auto-submit when settings change
    }
}

class BeeminderSettingTab extends PluginSettingTab {
    plugin: ExamplePlugin;

    constructor(app: App, plugin: ExamplePlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        new Setting(containerEl)
            .setName('Beeminder API Key')
            .setDesc('Enter your Beeminder API key.')
            .addText(text => text
                .setPlaceholder('api-key')
                .setValue(this.plugin.settings.apiKey)
                .onChange(async (value) => {
                    this.plugin.settings.apiKey = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Beeminder Username')
            .setDesc('Enter your Beeminder username.')
            .addText(text => text
                .setPlaceholder('username')
                .setValue(this.plugin.settings.username)
                .onChange(async (value) => {
                    this.plugin.settings.username = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('h3', {text: 'Goals and File Paths'});

        this.plugin.settings.goals.forEach((goal, index) => {
            const goalContainer = containerEl.createDiv();

            new Setting(goalContainer)
                .setName(`Goal ${index + 1}`)
                .addText(text => text
                    .setPlaceholder('goal-slug')
                    .setValue(goal.slug)
                    .onChange(async (value) => {
                        goal.slug = value;
                        await this.plugin.saveSettings();
                    }))
                .addText(text => text
                    .setPlaceholder('file/path.md')
                    .setValue(goal.filePath)
                    .onChange(async (value) => {
                        goal.filePath = value;
                        await this.plugin.saveSettings();
                    }))
                .addDropdown(dropdown => dropdown
                    .addOption('wordCount', 'Word Count')
                    .addOption('completedTasks', 'Completed Tasks')
                    .addOption('uncompletedTasks', 'Uncompleted Tasks')
                    .setValue(goal.metricType)
                    .onChange(async (value: 'wordCount' | 'completedTasks' | 'uncompletedTasks') => {
                        goal.metricType = value;
                        await this.plugin.saveSettings();
                    }))
                .addToggle(toggle => toggle
                    .setValue(goal.isAutoSubmit)
                    .setTooltip('Toggle automatic submission')
                    .onChange(async (value) => {
                        goal.isAutoSubmit = value;
                        await this.plugin.saveSettings();
                        this.display();
                    }))
                .addButton(button => button
                    .setButtonText('Remove')
                    .onClick(async () => {
                        this.plugin.settings.goals.splice(index, 1);
                        await this.plugin.saveSettings();
                        this.display();
                    }));

            if (goal.isAutoSubmit) {
                new Setting(goalContainer)
                    .setName('Polling Frequency')
                    .addText(text => text
                        .setPlaceholder('HH:MM:SS')
                        .setValue(`${goal.pollingFrequency.hours.toString().padStart(2, '0')}:${goal.pollingFrequency.minutes.toString().padStart(2, '0')}:${goal.pollingFrequency.seconds.toString().padStart(2, '0')}`)
                        .onChange(async (value) => {
                            const [hours, minutes, seconds] = value.split(':').map(Number);
                            goal.pollingFrequency = { hours, minutes, seconds };
                            await this.plugin.saveSettings();
                        }));
            }
        });

        new Setting(containerEl)
            .addButton(button => button
                .setButtonText('Add Goal')
                .onClick(async () => {
                    this.plugin.settings.goals.push({
                        slug: '',
                        filePath: '',
                        isAutoSubmit: false,
                        metricType: 'wordCount', // Default to word count
                        pollingFrequency: { hours: 0, minutes: 5, seconds: 0 }
                    });
                    await this.plugin.saveSettings();
                    this.display();
                }));

        this.addHotkeySection(containerEl);
    }

    addHotkeySection(containerEl: HTMLElement) {
        containerEl.createEl('h3', {text: 'Hotkeys'});

        for (let i = 1; i <= 10; i++) {
            new Setting(containerEl)
                .setName(`Goal ${i} Hotkey`)
                .setDesc(`Hotkey to submit data for Goal ${i}`)
                .addButton(button => button
                    .setButtonText('Go to Hotkeys')
                    .onClick(() => {
                        // Open Obsidian's hotkey settings for this command
                        this.app.setting.openTabById('hotkeys');
                        const hotkeySetting = this.app.setting.activeTab.containerEl.querySelector(`[data-hotkey-id="beeminder-obsidian:submit-beeminder-datapoint-goal-${i}"]`);
                        if (hotkeySetting) {
                            hotkeySetting.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                    }));
        }
    }
}