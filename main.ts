import { Plugin, PluginSettingTab, Setting, App, TFile, WorkspaceLeaf, Modal, debounce, Notice, TFolder } from "obsidian";
import moment from 'moment-timezone';
import { Queue } from './queue'; // We'll create this file next

// Add this utility function at the top of your file
function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 1. Extend the Settings Interface
interface BeeminderSettings {
    apiKey: string;
    username: string;
    timezone: string;
    dayEndTime: string; // in 24-hour format, e.g., "06:00"
    dayEndMinute: number;
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
        isDailyNote: boolean;
    }>;
    dayEndHour: number;
    dailyNotesFolder: string;
    dailyNoteDayEndTime: string; // New field for daily note day end time
    beeminderDayEndTime: string; // Renamed from dayEndTime
}

const DEFAULT_SETTINGS: BeeminderSettings = {
    apiKey: '',
    username: '',
    timezone: '', // Add this if it's not already present
    dayEndTime: '00:00', // Add this line
    dayEndHour: 0, // Add this line
    dayEndMinute: 0, // Add this line
    goals: [], // Add this if it's not already present
    dailyNotesFolder: 'Daily Notes',
    dailyNoteDayEndTime: '00:00',
    beeminderDayEndTime: '00:00',
};

const validateTime = (hours: number, minutes: number): boolean => {
    if (hours === 6 && minutes > 0) {
        return false;
    }
    return true;
};

const formatTime = (hours: number, minutes: number): string => {
    return moment({ hours, minutes }).format('HH:mm');
};

const setDayEndTime = (hours: number, minutes: number) => {
    if (validateTime(hours, minutes)) {
        const time = formatTime(hours, minutes);
        // Save the time to your settings
        // Update your UI or perform any other necessary actions
    } else {
        new Notice('Invalid time. Please choose between 00:00-06:00 or 07:00-23:59.');
    }
};

// When calculating the target date for Beeminder
const getTargetDate = (dayEndTime: string): string => {
    const now = moment();
    const endTime = moment(dayEndTime, 'HH:mm');
    
    let targetDate = now.clone();
    if (now.hour() < endTime.hour() || (now.hour() === endTime.hour() && now.minute() < endTime.minute())) {
        targetDate.subtract(1, 'day');
    }

    return targetDate.format('YYYY-MM-DD');
};

export default class ExamplePlugin extends Plugin {
    settings: BeeminderSettings;
    private intervalIds: { [key: string]: number } = {};
    private updateQueue: Queue<string>;
    private isProcessingQueue: boolean;

    async onload() {
        console.log("Hello world");

        // Load settings
        await this.loadSettings();

        // Add settings tab
        this.addSettingTab(new BeeminderSettingTab(this.app, this));

        // Update commands
        this.updateCommands();

        this.updateQueue = new Queue<string>();
        this.isProcessingQueue = false;

        // Set up interval for automatic submissions if enabled
        this.setupAutoSubmit();
        this.startQueueProcessor();
    }

    onunload() {
        // Clear all intervals when the plugin is disabled
        Object.values(this.intervalIds).forEach(clearInterval);
        console.log("Goodbye world");
    }

    private startQueueProcessor() {
        setInterval(() => {
            this.processQueue();
        }, 10000); // Check queue every 5 seconds
    }

    private async processQueue() {
        if (this.isProcessingQueue || this.updateQueue.isEmpty()) {
            return;
        }

        this.isProcessingQueue = true;
        const filePath = this.updateQueue.dequeue();
        if (filePath) {
            await this.checkAndUpdateBeeminder(filePath);
        }
        this.isProcessingQueue = false;
    }

    private async manualSubmitDatapoint(goalIndex?: number) {
        if (goalIndex !== undefined && goalIndex < this.settings.goals.length) {
            const goal = this.settings.goals[goalIndex];
            this.updateQueue.enqueue(goal.filePath);
        } else {
            // If no specific goal is specified, update all goals
            for (const goal of this.settings.goals) {
                this.updateQueue.enqueue(goal.filePath);
            }
        }
    }

    private setupAutoSubmit() {
        // Clear all existing intervals
        Object.values(this.intervalIds).forEach(clearInterval);
        this.intervalIds = {};

        // Set up new intervals for each auto-submit goal
        this.settings.goals.forEach((goal, index) => {
            if (goal.isAutoSubmit) {
                const totalMilliseconds = 
                    (goal.pollingFrequency.hours * 3600 +
                     goal.pollingFrequency.minutes * 60 +
                     goal.pollingFrequency.seconds) * 1000;
                
                this.intervalIds[goal.slug] = window.setInterval(() => {
                    this.autoSubmitDatapoint(index);
                }, totalMilliseconds);
            }
        });
    }

    private async autoSubmitDatapoint(goalIndex: number) {
        const goal = this.settings.goals[goalIndex];
        console.log(`Auto-submitting datapoint for goal: ${goal.slug}`);
        
        let file: TFile | null = null;
        if (goal.isDailyNote) {
            file = this.getDailyNote();
        } else {
            const abstractFile = this.app.vault.getAbstractFileByPath(goal.filePath);
            if (abstractFile instanceof TFile) {
                file = abstractFile;
            }
        }

        if (file) {
            await this.checkAndUpdateBeeminder(file.path);
        } else {
            console.log(`No file found for goal: ${goal.slug}`);
        }
    }

    private async checkAndUpdateBeeminder(filePath: string) {
        const goal = this.settings.goals.find(g => g.filePath === filePath || g.isDailyNote);
        if (goal) {
            let file: TFile | null = null;
            if (goal.isDailyNote) {
                file = this.getDailyNote();
            } else {
                const abstractFile = this.app.vault.getAbstractFileByPath(filePath);
                if (abstractFile instanceof TFile) {
                    file = abstractFile;
                }
            }

            if (file) {
                const fileContent = await this.app.vault.read(file);
                let value: number;
                switch (goal.metricType) {
                    case 'wordCount':
                        value = fileContent.split(/\s+/).length;
                        break;
                    case 'completedTasks':
                        value = fileContent.split(/\r?\n/).filter(line => line.trim().startsWith("- [x]")).length;
                        break;
                    case 'uncompletedTasks':
                        value = fileContent.split(/\r?\n/).filter(line => line.trim().startsWith("- [ ]")).length;
                        break;
                    default:
                        console.error(`Unknown metric type: ${goal.metricType}`);
                        return;
                }

                const lastDatapoint = await this.getBeeminderLastDatapoint(goal.slug);
                const currentDayStamp = this.getCurrentDayStamp(false); // Use Beeminder day end time
                
                if (lastDatapoint.daystamp === currentDayStamp) {
                    await this.updateBeeminderDataPoint(value, goal.slug, file, lastDatapoint.id);
                } else {
                    await this.pushBeeminderDataPoint(value, goal.slug, file);
                }
            }
        }
    }

    private getCurrentDayStamp(isForDailyNote: boolean = false): string {
        const now = moment.tz(this.settings.timezone);
        const dayEndTime = moment.tz(
            now.format('YYYY-MM-DD') + ' ' + 
            (isForDailyNote ? this.settings.dailyNoteDayEndTime : this.settings.beeminderDayEndTime), 
            'YYYY-MM-DD HH:mm', 
            this.settings.timezone
        );
        
        if (now.isBefore(dayEndTime)) {
            return now.format('YYYYMMDD');
        } else {
            return now.add(1, 'day').format('YYYYMMDD');
        }
    }

    private getDailyNote(): TFile | null {
        const currentDayStamp = this.getCurrentDayStamp(true); // Use daily note day end time
        console.log(`Searching for daily note with stamp: ${currentDayStamp}`);

        // First, try to find the daily note using the Daily Notes plugin's API if available
        // @ts-ignore
        const dailyNotePlugin = this.app.plugins.getPlugin('daily-notes');
        if (dailyNotePlugin && dailyNotePlugin.getDailyNote) {
            const dailyNote = dailyNotePlugin.getDailyNote();
            if (dailyNote) {
                console.log(`Found daily note using Daily Notes plugin: ${dailyNote.path}`);
                return dailyNote;
            }
        }

        // If the Daily Notes plugin method didn't work, try to find the note manually
        const dailyNotesFolder = this.app.vault.getAbstractFileByPath(this.settings.dailyNotesFolder || 'Daily Notes');
        if (!(dailyNotesFolder instanceof TFolder)) {
            console.error(`Daily notes folder not found: ${this.settings.dailyNotesFolder || 'Daily Notes'}`);
            return null;
        }

        // Log all files in the daily notes folder for debugging
        console.log('Files in daily notes folder:');
        dailyNotesFolder.children.forEach(file => {
            console.log(file.name);
        });

        // Try different date formats
        const dateFormats = ['YYYY-MM-DD', 'YYYYMMDD', 'DD-MM-YYYY', 'MM-DD-YYYY'];
        for (const format of dateFormats) {
            const formattedDate = moment(currentDayStamp, 'YYYYMMDD').format(format);
            const dailyNoteFile = dailyNotesFolder.children.find(file => file.name.startsWith(formattedDate));
            if (dailyNoteFile instanceof TFile) {
                console.log(`Found daily note: ${dailyNoteFile.path}`);
                return dailyNoteFile;
            }
        }

        console.error(`No daily note found for ${currentDayStamp}`);
        return null;
    }

    private async getBeeminderLastDatapoint(goalSlug: string): Promise<{ id: string, value: number, daystamp: string }> {
        const response = await fetch(`https://www.beeminder.com/api/v1/users/${this.settings.username}/goals/${goalSlug}/datapoints.json?auth_token=${this.settings.apiKey}&count=1`);
        const data = await response.json();
        if (data.length > 0) {
            return { id: data[0].id, value: data[0].value, daystamp: data[0].daystamp };
        }
        return { id: '', value: 0, daystamp: '' };
    }

    private shouldUpdateDatapoint(lastDatapoint: { daystamp: string }): boolean {
        const now = moment.tz(this.settings.timezone);
        const dayEndTime = moment.tz(now.format('YYYY-MM-DD') + ' ' + this.settings.dayEndTime, 'YYYY-MM-DD HH:mm', this.settings.timezone);
        
        if (dayEndTime.isBefore(now)) {
            dayEndTime.add(1, 'day');
        }

        return lastDatapoint.daystamp === now.format('YYYYMMDD') && now.isBefore(dayEndTime);
    }

    private async updateBeeminderDataPoint(value: number, goalSlug: string, file: TFile, datapointId: string) {
        const now = moment.tz(this.settings.timezone);
        const comment = `Updated from ${file.path} in Obsidian at ${now.format('HH:mm:ss')} ${this.settings.timezone}`;

        const response = await fetch(`https://www.beeminder.com/api/v1/users/${this.settings.username}/goals/${goalSlug}/datapoints/${datapointId}.json`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                auth_token: this.settings.apiKey,
                value: value,
                comment: comment
            })
        });
        const data = await response.json();
        console.log("Data updated on Beeminder:", data);
    }

    private async pushBeeminderDataPoint(value: number, goalSlug: string, file: TFile) {
        const now = moment.tz(this.settings.timezone);
        const comment = `Updated from ${file.path} in Obsidian at ${now.format('HH:mm:ss')} ${this.settings.timezone}`;

        const response = await fetch(`https://www.beeminder.com/api/v1/users/${this.settings.username}/goals/${goalSlug}/datapoints.json`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                auth_token: this.settings.apiKey,
                value: value,
                comment: comment,
                timestamp: now.unix()
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
        this.updateCommands(); // Update commands when settings change
    }

    // Add this new method
    private updateCommands() {
        // Remove existing commands
        this.removeCommand(`submit-beeminder-datapoint-all`);
        for (let i = 1; i <= 10; i++) {
            this.removeCommand(`submit-beeminder-datapoint-goal-${i}`);
        }

        // Add command for submitting all goals
        this.addCommand({
            id: 'submit-beeminder-datapoint-all',
            name: 'Submit Beeminder Datapoint for All Goals',
            callback: () => this.manualSubmitDatapoint(),
        });

        // Add commands for individual goals
        this.settings.goals.forEach((goal, index) => {
            if (index < 10) {
                this.addCommand({
                    id: `submit-beeminder-datapoint-goal-${index + 1}`,
                    name: `Submit Beeminder Datapoint for ${goal.slug || `Goal ${index + 1}`}`,
                    callback: () => this.manualSubmitDatapoint(index),
                });
            }
        });
    }
}

class BeeminderSettingTab extends PluginSettingTab {
    plugin: ExamplePlugin;
    private currentTimeDisplay: HTMLInputElement;

    constructor(app: App, plugin: ExamplePlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        new Setting(containerEl)
            .setName('API Key')
            .setDesc('Your Beeminder API key')
            .addText(text => text
                .setPlaceholder('Enter your API key')
                .setValue(this.plugin.settings.apiKey)
                .onChange(async (value) => {
                    this.plugin.settings.apiKey = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Username')
            .setDesc('Your Beeminder username')
            .addText(text => text
                .setPlaceholder('Enter your username')
                .setValue(this.plugin.settings.username)
                .onChange(async (value) => {
                    this.plugin.settings.username = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Timezone')
            .setDesc('Your timezone')
            .addText(text => text
                .setPlaceholder('e.g. America/New_York')
                .setValue(this.plugin.settings.timezone)
                .onChange(async (value) => {
                    this.plugin.settings.timezone = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Day End Time')
            .setDesc('Set the end time for your Beeminder day')
            .addSlider(slider => {
                const minutes = this.timeStringToMinutes(this.plugin.settings.beeminderDayEndTime);
                slider
                    .setLimits(0, 1439, 1)
                    .setValue(minutes)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.beeminderDayEndTime = this.minutesToTimeString(value);
                        await this.plugin.saveSettings();
                        this.display();
                    });
            })
            .addExtraButton(button => button
                .setIcon('reset')
                .setTooltip('Reset to midnight')
                .onClick(async () => {
                    this.plugin.settings.beeminderDayEndTime = '00:00';
                    await this.plugin.saveSettings();
                    this.display();
                }))
            .addExtraButton(button => button
                .setIcon('clock')
                .setTooltip(this.plugin.settings.beeminderDayEndTime)
            );

        containerEl.createEl('h3', {text: 'Regular Note Goals'});
        this.displayRegularGoals(containerEl);

        new Setting(containerEl)
            .addButton(button => button
                .setButtonText('Add Regular Goal')
                .onClick(async () => {
                    this.addNewGoal(false);
                }));

        containerEl.createEl('h3', {text: 'Daily Note Goals'});
        this.displayDailyNoteGoals(containerEl);

        new Setting(containerEl)
            .addButton(button => button
                .setButtonText('Add Daily Note Goal')
                .onClick(async () => {
                    this.addNewGoal(true);
                }));

        this.addHotkeySection(containerEl);

        new Setting(containerEl)
            .setName('Daily Notes Folder')
            .setDesc('Set the folder path for your daily notes')
            .addText(text => text
                .setPlaceholder('Daily Notes')
                .setValue(this.plugin.settings.dailyNotesFolder)
                .onChange(async (value) => {
                    this.plugin.settings.dailyNotesFolder = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Daily Note Day End Time')
            .setDesc('Set the end time for your daily notes (HH:MM)')
            .addText(text => text
                .setPlaceholder('00:00')
                .setValue(this.plugin.settings.dailyNoteDayEndTime)
                .onChange(async (value) => {
                    this.plugin.settings.dailyNoteDayEndTime = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Beeminder Day End Time')
            .setDesc('Set the end time for your Beeminder day (HH:MM)')
            .addText(text => text
                .setPlaceholder('00:00')
                .setValue(this.plugin.settings.beeminderDayEndTime)
                .onChange(async (value) => {
                    this.plugin.settings.beeminderDayEndTime = value;
                    await this.plugin.saveSettings();
                }));
    }

    displayRegularGoals(containerEl: HTMLElement) {
        this.plugin.settings.goals
            .filter(goal => !goal.isDailyNote)
            .forEach((goal, index) => {
                this.createGoalSetting(containerEl, goal, index, false);
            });
    }

    displayDailyNoteGoals(containerEl: HTMLElement) {
        this.plugin.settings.goals
            .filter(goal => goal.isDailyNote)
            .forEach((goal, index) => {
                this.createGoalSetting(containerEl, goal, index, true);
            });
    }

    createGoalSetting(containerEl: HTMLElement, goal: any, index: number, isDailyNote: boolean) {
        const goalContainer = containerEl.createDiv();

        new Setting(goalContainer)
            .setName(`${isDailyNote ? 'Daily Note' : 'Regular'} Goal ${index + 1}`)
            .addText(text => text
                .setPlaceholder('goal-slug')
                .setValue(goal.slug)
                .onChange(async (value) => {
                    goal.slug = value;
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
            .addButton(button => button
                .setButtonText('Remove')
                .onClick(async () => {
                    this.plugin.settings.goals = this.plugin.settings.goals.filter(g => g !== goal);
                    await this.plugin.saveSettings();
                    this.display();
                }));

        new Setting(goalContainer)
            .setName('Auto Submit')
            .addToggle(toggle => toggle
                .setValue(goal.isAutoSubmit)
                .onChange(async (value) => {
                    goal.isAutoSubmit = value;
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

        if (!isDailyNote) {
            new Setting(goalContainer)
                .setName('File Path')
                .addText(text => text
                    .setPlaceholder('file/path.md')
                    .setValue(goal.filePath)
                    .onChange(async (value) => {
                        goal.filePath = value;
                        await this.plugin.saveSettings();
                    }));
        }
    }
    async addNewGoal(isDailyNote: boolean) {
        this.plugin.settings.goals.push({
            slug: '',
            filePath: '',
            isAutoSubmit: false,
            metricType: 'wordCount',
            pollingFrequency: { hours: 0, minutes: 5, seconds: 0 },
            isDailyNote: isDailyNote,
            dailyNoteSubmissionTime: '23:59', // Corrected to dailyNoteSubmissionTime
            dailySubmitTime: '23:59' // Default to 23:59
        });
        await this.plugin.saveSettings();
        this.display();
    }
    updateCurrentTimeDisplay(hours: number, minutes: number) {
        if (this.currentTimeDisplay) {
            this.currentTimeDisplay.value = formatTime(hours, minutes);
        }
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
                        (this.app as any).setting.open();
                        (this.app as any).setting.openTabById('hotkeys');
                        setTimeout(() => {
                            const hotkeySetting = document.querySelector(`[data-hotkey-id="beeminder-obsidian:submit-beeminder-datapoint-goal-${i}"]`);
                            if (hotkeySetting) {
                                hotkeySetting.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }
                        }, 300);
                    }));
        }
    }

    private timeStringToMinutes(timeString: string): number {
        const [hours, minutes] = timeString.split(':').map(Number);
        return hours * 60 + minutes;
    }

    private minutesToTimeString(minutes: number): string {
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
    }
}