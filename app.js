"use strict";

/**
 * ==========================================
 * 1. CAPA DE DATOS (IndexedDB)
 * ==========================================
 * Gestiona de forma asíncrona y robusta el almacenamiento local.
 */
class LocalDB {
    constructor(dbName = 'OrganizateYaDB', version = 1) {
        this.dbName = dbName;
        this.version = version;
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                // Tabla de Procesos (Plantillas)
                if (!db.objectStoreNames.contains('procesos')) {
                    db.createObjectStore('procesos', { keyPath: 'id' });
                }
                // Tabla de Registros (Instancias en ejecución con archivos/comentarios)
                if (!db.objectStoreNames.contains('registros')) {
                    db.createObjectStore('registros', { keyPath: 'id' });
                }
                // Tabla de Ajustes de Usuario
                if (!db.objectStoreNames.contains('settings')) {
                    db.createObjectStore('settings', { keyPath: 'key' });
                }
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                resolve(this.db);
            };

            request.onerror = (event) => reject(event.target.error);
        });
    }

    async save(storeName, data) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([storeName], 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.put(data);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async get(storeName, key) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([storeName], 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getAll(storeName) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([storeName], 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
}

/**
 * ==========================================
 * 2. CAPA DE SINCRONIZACIÓN BACKEND (Apps Script)
 * ==========================================
 * Preparado para enviar solo la estructura de texto (Procesos) y evitar peso.
 */
class CloudSync {
    static BACKEND_URL = 'URL_DE_TU_WEB_APP_APPS_SCRIPT_AQUI';

    static async shareProcess(proceso) {
        // Limpiamos datos pesados (archivos/audios) por seguridad antes de enviar
        const payload = {
            id: proceso.id,
            nombre: proceso.nombre,
            tareas: proceso.tareas.map(t => ({
                nombre: t.nombre,
                tiempoMin: t.tiempoMin
            })),
            timestamp: Date.now()
        };

        try {
            const response = await fetch(this.BACKEND_URL, {
                method: 'POST',
                mode: 'no-cors', // Necesario para Apps Script sin autenticación compleja
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            console.log("Proceso enviado al backend con éxito.");
            return true;
        } catch (error) {
            console.error("Error al sincronizar con el backend. Guardado offline.", error);
            return false;
        }
    }
}

/**
 * ==========================================
 * 3. CONTROLADOR DE ESTADO (Manejo del Tiempo)
 * ==========================================
 * Soluciona el bug del tiempo calculando marcas absolutas (Date.now())
 */
class ProcessRunner {
    constructor(db) {
        this.db = db;
        this.currentSession = null;
    }

    async startProcess(procesoData) {
        this.currentSession = {
            id: `session_${Date.now()}`,
            procesoId: procesoData.id,
            nombre: procesoData.nombre,
            inicioAbsolutoMs: Date.now(),
            tiempoPausadoTotalMs: 0,
            ultimaPausaMs: null,
            tareasPendientes: [...procesoData.tareas],
            tareasCompletadas: [],
            estado: 'activo' // activo, pausado, finalizado
        };
        await this.db.save('registros', this.currentSession);
        this.startNextTask();
    }

    startNextTask() {
        if (this.currentSession.tareasPendientes.length === 0) {
            this.finishProcess();
            return;
        }

        const nextTask = this.currentSession.tareasPendientes.shift();
        this.currentSession.tareaActual = {
            ...nextTask,
            inicioMs: Date.now(),
            comentarios: "",
            evidenciaArchivos: [] // Aquí se guardarán temporalmente los blobs de las fotos/audios
        };
        
        this.db.save('registros', this.currentSession);
    }

    // Calcula el tiempo real basado en la hora del sistema, inmune a cierres de pestaña
    getElapsedTaskTime() {
        if (!this.currentSession || !this.currentSession.tareaActual) return 0;
        
        const tarea = this.currentSession.tareaActual;
        if (this.currentSession.estado === 'pausado') {
            return this.currentSession.ultimaPausaMs - tarea.inicioMs;
        }
        return Date.now() - tarea.inicioMs;
    }

    togglePause() {
        if (this.currentSession.estado === 'activo') {
            this.currentSession.estado = 'pausado';
            this.currentSession.ultimaPausaMs = Date.now();
        } else if (this.currentSession.estado === 'pausado') {
            this.currentSession.estado = 'activo';
            const tiempoEnPausa = Date.now() - this.currentSession.ultimaPausaMs;
            // Desplazamos el tiempo de inicio hacia adelante para compensar la pausa
            this.currentSession.tareaActual.inicioMs += tiempoEnPausa;
            this.currentSession.inicioAbsolutoMs += tiempoEnPausa;
            this.currentSession.ultimaPausaMs = null;
        }
        this.db.save('registros', this.currentSession);
    }

    finishProcess() {
        this.currentSession.estado = 'finalizado';
        this.currentSession.finAbsolutoMs = Date.now();
        this.db.save('registros', this.currentSession);
        // Aquí dispararíamos el renderizado de gráficas
    }
}

/**
 * ==========================================
 * 4. INICIALIZADOR DE LA APP (PWA & Arranque)
 * ==========================================
 */
class App {
    constructor() {
        this.db = new LocalDB();
        this.runner = null;
    }

    async init() {
        this.registerServiceWorker();
        await this.db.init();
        this.runner = new ProcessRunner(this.db);
        
        // TODO: Inyectar la clase de UI Controller que crearemos en el siguiente paso
        console.log("🚀 Motor de datos, PWA y lógica de tiempo inicializados correctamente.");
    }

    registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('./sw.js')
                    .then(reg => console.log('PWA Lista. Scope:', reg.scope))
                    .catch(err => console.error('Fallo al registrar PWA:', err));
            });
        }
    }
}

// Arrancar el motor
const app = new App();
document.addEventListener('DOMContentLoaded', () => app.init());
/**
 * ==========================================
 * 5. SISTEMA DE NOTIFICACIONES Y ALARMAS
 * ==========================================
 */
class NotificationEngine {
    static async requestPermission() {
        if (!('Notification' in window)) return false;
        if (Notification.permission === 'granted') return true;
        const permission = await Notification.requestPermission();
        return permission === 'granted';
    }

    static sendAlert(title, body) {
        if ('Notification' in window && Notification.permission === 'granted') {
            // Utilizamos el ServiceWorker para mostrar la notificación si está disponible, 
            // esto asegura que funcione mejor en móviles incluso minimizado.
            navigator.serviceWorker.ready.then(registration => {
                registration.showNotification(title, {
                    body: body,
                    icon: 'icon.png',
                    vibrate: [300, 100, 400], // Patrón de vibración de alerta
                    tag: 'proceso-alerta' // Evita que se acumulen 100 notificaciones iguales
                });
            }).catch(() => {
                // Fallback si el SW no está listo
                new Notification(title, { body, vibrate: [300, 100, 400] });
            });
        }
    }
}

/**
 * ==========================================
 * 6. CONTROLADOR DE INTERFAZ (UI Controller)
 * ==========================================
 * Inyecta las plantillas HTML, gestiona eventos y actualiza la vista.
 */
class UIController {
    constructor(appInstance) {
        this.app = appInstance; // Referencia al motor de datos y tiempo
        this.root = document.getElementById('app-root');
        
        // Plantillas disponibles
        this.templates = {
            home: document.getElementById('tpl-home'),
            runner: document.getElementById('tpl-runner'),
            editor: document.getElementById('tpl-editor'),
            settings: document.getElementById('tpl-settings'),
            stats: document.getElementById('tpl-stats')
        };
        
        this.uiInterval = null; // Intervalo exclusivo para actualizar la barra de progreso
    }

    async init() {
        this.setupGlobalNavigation();
        // Pedimos permiso para notificar desde el primer momento
        await NotificationEngine.requestPermission();
        this.navigate('home');
    }

    // --- ENRUTADOR BASADO EN PLANTILLAS ---
    navigate(viewName) {
        this.root.innerHTML = ''; // Limpiar vista actual
        clearInterval(this.uiInterval); // Detener actualizaciones de interfaz previas

        const template = this.templates[viewName];
        if (!template) return;

        // Clonar el contenido de la plantilla e inyectarlo
        const clone = template.content.cloneNode(true);
        this.root.appendChild(clone);

        // Ejecutar la lógica específica de cada vista
        if (viewName === 'home') this.renderHome();
        if (viewName === 'runner') this.setupRunner();
        if (viewName === 'editor') this.setupEditor();
    }

    setupGlobalNavigation() {
        document.querySelector('.main-nav').addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-route]');
            if (btn) this.navigate(btn.dataset.route);
        });
    }

    // --- VISTA: INICIO (Lista de Procesos) ---
    async renderHome() {
        const listContainer = document.getElementById('procesos-list');
        const procesos = await this.app.db.getAll('procesos');

        if (procesos.length === 0) {
            listContainer.innerHTML = '<p>No tienes procesos. Ve a "Editar Procesos" para crear uno.</p>';
            return;
        }

        procesos.forEach(proc => {
            const totalTime = proc.tareas.reduce((acc, t) => acc + t.tiempoMin, 0);
            const btn = document.createElement('button');
            btn.className = 'proceso-card';
            btn.innerHTML = `
                <h3>${proc.nombre}</h3>
                <small>⏱️ ~${totalTime} min | 📋 ${proc.tareas.length} pasos</small>
            `;
            btn.onclick = async () => {
                await this.app.runner.startProcess(proc);
                this.navigate('runner');
            };
            listContainer.appendChild(btn);
        });
    }

    // --- VISTA: EJECUCIÓN (Runner) ---
    setupRunner() {
        const session = this.app.runner.currentSession;
        if (!session || session.estado === 'finalizado') {
            this.navigate('home');
            return;
        }

        // Referencias del DOM inyectado
        const titleEl = document.querySelector('.tarea-titulo');
        const progressEl = document.querySelector('.progreso-bar');
        const startEl = document.querySelector('.start-time');
        const endEl = document.querySelector('.end-time');
        const msgEl = document.querySelector('.mensaje-display');
        
        // Configurar botones de acción
        document.querySelector('[data-action="pause"]').addEventListener('click', () => {
            this.app.runner.togglePause();
        });

        document.querySelector('[data-action="finish"]').addEventListener('click', () => {
            // Guardar comentarios/evidencia si existen
            const comment = document.querySelector('.task-comment')?.value;
            if (comment) session.tareaActual.comentarios = comment;
            
            this.app.runner.startNextTask();
            this.navigate('runner'); // Recargar la vista con la nueva tarea
        });

        // Bucle de actualización de UI (60 FPS para suavidad, pero calcula tiempo absoluto)
        this.uiInterval = setInterval(() => {
            const isPaused = session.estado === 'pausado';
            const tarea = session.tareaActual;
            
            if (!tarea) {
                clearInterval(this.uiInterval);
                this.navigate('stats');
                return;
            }

            // UI de Tiempos Absolutos
            startEl.textContent = new Date(tarea.inicioMs).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
            
            const tiempoObjetivoMs = tarea.tiempoMin * 60 * 1000;
            const finalEstimado = new Date(tarea.inicioMs + tiempoObjetivoMs);
            endEl.textContent = finalEstimado.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});

            // Cálculo de Progreso
            const transcurridoMs = this.app.runner.getElapsedTaskTime();
            const porcentaje = Math.min((transcurridoMs / tiempoObjetivoMs) * 100, 100);
            
            progressEl.style.width = `${porcentaje}%`;
            progressEl.textContent = `${Math.round(porcentaje)}%`;

            // Alerta de Tiempo Excedido
            if (porcentaje >= 100 && !tarea.notificado) {
                progressEl.style.backgroundColor = '#FF5722';
                NotificationEngine.sendAlert("¡Tiempo Excedido!", `La tarea "${tarea.nombre}" ha superado los ${tarea.tiempoMin} minutos.`);
                tarea.notificado = true; // Evitar spam de notificaciones
            }

            titleEl.textContent = isPaused ? `⏸️ PAUSADO: ${tarea.nombre}` : `▶️ ${tarea.nombre}`;
        }, 1000);

        // Mostrar sección de evidencia
        document.querySelector('.evidence-section').classList.remove('hidden');
        document.querySelector('[data-action="pause"]').classList.remove('hidden');
        document.querySelector('[data-action="finish"]').classList.remove('hidden');
        document.querySelector('[data-action="start"]').classList.add('hidden');
    }

    // --- VISTA: EDITOR (CRUD Básico) ---
    async setupEditor() {
        const container = document.querySelector('.editor-list');
        const procesos = await this.app.db.getAll('procesos');

        procesos.forEach(proc => {
            const div = document.createElement('div');
            div.className = 'editor-item';
            div.innerHTML = `<strong>${proc.nombre}</strong> <button data-id="${proc.id}" class="btn-warning">Editar</button>`;
            container.appendChild(div);
        });

        document.querySelector('[data-action="new-process"]').addEventListener('click', () => {
            // Lógica para crear un nuevo proceso (Se construirá el formulario aquí)
            alert("Aquí se abrirá el formulario para añadir pasos de tiempo y voz");
        });
    }
}

// Modificación al final de app.js para inicializar el UIController
document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    const ui = new UIController(app);
    app.init().then(() => ui.init());
});
let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
    // Evita que el navegador muestre su propio banner automático
    e.preventDefault();
    deferredPrompt = e;
    
    // Muestra tu botón personalizado
    const installBtn = document.getElementById('btn-instalar');
    if (installBtn) {
        installBtn.style.display = 'inline-block';
    }
});

document.getElementById('btn-instalar')?.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    
    // Lanza el diálogo nativo de instalación
    deferredPrompt.prompt();
    
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
        console.log('El usuario aceptó instalar la PWA');
    }
    deferredPrompt = null;
    document.getElementById('btn-instalar').style.display = 'none';
});

// Detectar si ya fue instalada para ocultar el botón permanentemente
window.addEventListener('appinstalled', () => {
    const installBtn = document.getElementById('btn-instalar');
    if (installBtn) installBtn.style.display = 'none';
    deferredPrompt = null;
});
