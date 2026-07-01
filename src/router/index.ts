import { createRouter, createWebHistory } from 'vue-router'
import DocPage from '../pages/DocPage.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', redirect: '/intro' },
    { path: '/:slug', name: 'doc', component: DocPage },
    { path: '/:pathMatch(.*)*', name: 'notfound', component: DocPage },
  ],
  scrollBehavior() {
    return { top: 0 }
  },
})

export default router
